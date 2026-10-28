import { spawn as spawnChild } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { TerminalSize } from '@craft-agent/shared/protocol'
import type { PtyProcess } from './session-terminal'

// node-pty's tty.ReadStream is not supported by Bun. Keep the native PTY in a Node child,
// using a bounded JSON-lines bridge; its shell still runs in the session's server worktree.
const WORKER = String.raw`
const pty = require(process.argv[1]);
const options = JSON.parse(process.argv[2]);
const { execFileSync } = require('node:child_process');
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let terminal;
let shellExit;
let rootIdentity;
let resolveShellExit;
const shellExited = new Promise(resolve => { resolveShellExit = resolve; });
let stopRequested = false;
let stopping;
let forceRequested = false;
const owned = new Map();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
process.stdout.on('error', () => {});
function finish(event) {
  process.stdout.write(JSON.stringify({ type: 'exit', exitCode: event.exitCode }) + '\n', () => process.exit(0));
}
function processTable() {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024 });
  const table = new Map();
  for (const row of rows.trim().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(row);
    if (!match) continue;
    const [, pid, parent, group, state, started] = match;
    let identity = started;
    if (process.platform === 'linux') {
      try {
        const stat = require('node:fs').readFileSync('/proc/' + pid + '/stat', 'utf8');
        identity = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      } catch { continue; }
    }
    table.set(Number(pid), { pid: Number(pid), parent: Number(parent), group: Number(group), identity, state });
  }
  return table;
}
function sameProcess(a, b) { return a && b && a.pid === b.pid && a.identity === b.identity && a.group === b.group; }
function collect(table) {
  const visit = parent => {
    for (const row of table.values()) {
      if (row.parent !== parent) continue;
      owned.set(row.pid, row);
      visit(row.pid);
    }
  };
  if (sameProcess(rootIdentity, table.get(terminal.pid))) visit(terminal.pid);
  // Keep identities for jobs reparented after an intermediate process exited.
  for (const [pid, original] of owned) if (!sameProcess(original, table.get(pid))) owned.delete(pid);
  return [...owned.values()].filter(original => !table.get(original.pid).state.startsWith('Z'));
}
function signalProcess(original, signal) {
  // Recheck identity immediately before each signal; never signal a recycled PID.
  const current = processTable().get(original.pid);
  if (!sameProcess(original, current) || current.state.startsWith('Z')) return;
  try { process.kill(original.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function stopOwned(signal) {
  const table = processTable();
  const shell = rootIdentity;
  let jobs = collect(table);
  for (const job of jobs) signalProcess(job, signal);
  const started = Date.now();
  // Keep the shell/worker alive until ordinary jobs are gone. A HUP-ignoring job must
  // receive KILL before the shell's exit can be acknowledged to checkout cleanup.
  while (jobs.length) {
    if (Date.now() - started > 2500) throw new Error('Terminal jobs did not stop; the checkout has been preserved.');
    await pause(50);
    jobs = collect(processTable());
    if (forceRequested || signal === 'SIGKILL' || Date.now() - started >= 500) {
      for (const job of jobs) signalProcess(job, 'SIGKILL');
    }
  }
  if (!shellExit && sameProcess(shell, processTable().get(terminal.pid))) terminal.kill(signal);
  let rejectForce;
  const forceFailed = new Promise((_, reject) => { rejectForce = reject; });
  const forceShell = setTimeout(() => {
    try { if (!shellExit && sameProcess(shell, processTable().get(terminal.pid))) terminal.kill('SIGKILL'); }
    catch (error) { rejectForce(error); }
  }, 250);
  try { await Promise.race([shellExited, forceFailed]); } finally { clearTimeout(forceShell); }
  // A final identity check catches a child forked between the last scan and shell exit.
  jobs = collect(processTable());
  for (const job of jobs) signalProcess(job, 'SIGKILL');
  const deadline = Date.now() + 500;
  while (collect(processTable()).length) {
    if (Date.now() >= deadline) throw new Error('Terminal jobs are still exiting; the checkout has been preserved.');
    await pause(25);
  }
  finish(shellExit);
}
function stop(signal = 'SIGHUP') {
  if (!terminal) return;
  stopRequested = true;
  if (signal === 'SIGKILL') forceRequested = true;
  if (stopping) return stopping;
  if (process.platform === 'win32') { terminal.kill(); shellExited.then(() => finish(shellExit)); return; }
  stopping = stopOwned(signal).catch(error => { stopping = undefined; send({ type: 'error', message: error.message }); });
  return stopping;
}
try {
  if (process.platform !== 'win32') processTable(); // Fail before spawning if process ownership cannot be inspected.
  terminal = pty.spawn(options.shell, process.platform === 'win32' ? [] : ['-l'], {
    name: 'xterm-256color', cwd: options.directory, cols: options.cols, rows: options.rows,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  if (process.platform !== 'win32') rootIdentity = processTable().get(terminal.pid);
  terminal.onData(data => send({ type: 'data', data }));
  terminal.onExit(event => { shellExit = event; resolveShellExit(); if (!stopRequested) finish(event); });
  send({ type: 'ready' });
  readline.createInterface({ input: process.stdin }).on('line', line => {
    try {
      const command = JSON.parse(line);
      if (command.type === 'write') terminal.write(command.data);
      else if (command.type === 'resize') terminal.resize(command.cols, command.rows);
      else if (command.type === 'kill') stop(command.signal);
    } catch (error) { send({ type: 'error', message: error.message }); }
  }).on('close', () => { void stop('SIGKILL'); });
  process.on('SIGTERM', () => stop('SIGKILL'));
} catch (error) { if (terminal) terminal.kill('SIGKILL'); send({ type: 'error', message: error.message }); process.exitCode = 1; }
`

function nodeExecutable(): string {
  if (process.env.CRAFT_TERMINAL_NODE) return process.env.CRAFT_TERMINAL_NODE
  if (!process.versions.bun) return process.execPath
  const bun = (globalThis as unknown as { Bun?: { which(command: string): string | null } }).Bun
  const node = bun?.which('node')
  if (!node) throw new Error('The server needs Node.js for interactive terminals. Install Node.js or set CRAFT_TERMINAL_NODE.')
  return node
}

/** Native-addon resolution remains external in the bundled server/desktop build. */
function ptyModule(): string {
  const runtimeRequire = typeof require === 'function' ? require : createRequire(resolve(process.argv[1] || 'package.json'))
  return runtimeRequire.resolve('node-pty')
}

export async function spawnSessionPty(directory: string, size: TerminalSize): Promise<PtyProcess> {
  const shell = process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL || '/bin/bash'
  const child = spawnChild(nodeExecutable(), ['-e', WORKER, ptyModule(), JSON.stringify({ directory, shell, ...size })], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  const dataListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<(event: { exitCode: number }) => void>()
  let backlog = ''
  let buffer = ''
  let stderr = ''
  let exit: { exitCode: number } | undefined
  let ready = false
  let runtimeError: Error | undefined
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const started = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const startupTimeout = setTimeout(() => { child.kill('SIGKILL'); rejectReady(new Error('The terminal runtime did not start.')) }, 10_000)
  const finish = (exitCode: number) => {
    if (exit) return
    exit = { exitCode }
    for (const listener of exitListeners) listener(exit)
  }
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-2048) })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line) continue
      try {
        const event = JSON.parse(line)
        if (event.type === 'ready') { ready = true; clearTimeout(startupTimeout); resolveReady() }
        else if (event.type === 'data' && typeof event.data === 'string') {
          if (dataListeners.size) for (const listener of dataListeners) listener(event.data)
          else backlog = (backlog + event.data).slice(-256 * 1024)
        } else if (event.type === 'exit') finish(Number.isInteger(event.exitCode) ? event.exitCode : 1)
        else if (event.type === 'error') {
          if (!ready) rejectReady(new Error(`The terminal could not start: ${String(event.message).slice(0, 500)}`))
          else child.kill('SIGTERM')
        }
      } catch { child.kill('SIGKILL'); rejectReady(new Error('The terminal runtime returned invalid output.')) }
    }
  })
  child.on('error', error => { clearTimeout(startupTimeout); rejectReady(new Error(`The terminal runtime is unavailable: ${error.message}`)); finish(1) })
  child.on('close', code => {
    clearTimeout(startupTimeout)
    if (!ready) rejectReady(new Error(`The terminal runtime could not start.${stderr ? ` ${stderr}` : ''}`))
    if (!ready) finish(code ?? 1)
    else if (!exit) {
      runtimeError = new Error('The terminal runtime exited before verifying its jobs stopped. Its checkout has been preserved.')
      const message = `\r\n${runtimeError.message}\r\n`
      if (dataListeners.size) for (const listener of dataListeners) listener(message)
      else backlog = message
    }
  })
  try { await started } catch (error) { child.kill('SIGKILL'); throw error }
  function command(value: object): void {
    if (runtimeError) throw runtimeError
    if (exit || child.stdin.destroyed) return
    if (child.stdin.writableLength > 1024 * 1024) throw new Error('The terminal is receiving input too quickly. Wait before trying again.')
    child.stdin.write(JSON.stringify(value) + '\n')
  }
  return {
    write(data) { command({ type: 'write', data }) },
    resize(cols, rows) { command({ type: 'resize', cols, rows }) },
    kill(signal = 'SIGHUP') { command({ type: 'kill', signal }) },
    onData(listener) {
      dataListeners.add(listener)
      if (backlog) { const saved = backlog; backlog = ''; queueMicrotask(() => { if (dataListeners.has(listener)) listener(saved) }) }
      return { dispose() { dataListeners.delete(listener) } }
    },
    onExit(listener) {
      exitListeners.add(listener)
      if (exit) { const saved = exit; queueMicrotask(() => { if (exitListeners.has(listener)) listener(saved) }) }
      return { dispose() { exitListeners.delete(listener) } }
    },
  }
}
