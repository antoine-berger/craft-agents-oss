import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSessionPty } from './node-pty'
import { spawn as spawnChild, execFileSync } from 'node:child_process'

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) { if (Date.now() > deadline) throw new Error('Expected native terminal output was not received.'); await new Promise(resolve => setTimeout(resolve, 10)) }
}

test('real Bun/Node PTY bridge supports typed input, resize and acknowledged exit', async () => {
  if (process.platform === 'win32') return
  const directory = await mkdtemp(join(tmpdir(), 'craft-terminal-'))
  const previousShell = process.env.SHELL, previousHome = process.env.HOME
  let pty: Awaited<ReturnType<typeof spawnSessionPty>> | undefined
  try {
    process.env.SHELL = '/bin/sh'; process.env.HOME = directory
    pty = await spawnSessionPty(directory, { cols: 80, rows: 24 })
    let output = ''
    pty.onData(data => { output += data })
    const exit = new Promise<number>(resolve => pty!.onExit(event => resolve(event.exitCode)))
    pty.write("test -t 0 && printf 'CRAFT_%s_OK\\n' PTY; pwd; stty size\r")
    await waitFor(() => output.includes('CRAFT_PTY_OK') && output.includes('24 80'))
    expect(output).toContain(directory)
    pty.resize(110, 35)
    pty.write('stty size\r')
    await waitFor(() => output.includes('35 110'))
    pty.write('exit 0\r')
    expect(await exit).toBe(0)
    pty = undefined
  } finally {
    pty?.kill('SIGKILL')
    if (previousShell === undefined) delete process.env.SHELL; else process.env.SHELL = previousShell
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)

function isRunning(pid: number): boolean {
  try {
    const state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim()
    return !!state && !state.startsWith('Z')
  } catch { return false }
}
async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try { const pid = Number(await readFile(path, 'utf8')); if (Number.isInteger(pid) && pid > 0) return pid } catch {}
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('The disposable terminal job did not start.')
}

test('Stop acknowledges only after a HUP-ignoring background job is gone', async () => {
  if (process.platform === 'win32') return
  const directory = await mkdtemp(join(tmpdir(), 'craft-terminal-stop-'))
  const previousShell = process.env.SHELL, previousHome = process.env.HOME
  let pty: Awaited<ReturnType<typeof spawnSessionPty>> | undefined
  let pid: number | undefined
  try {
    process.env.SHELL = '/bin/bash'; process.env.HOME = directory
    pty = await spawnSessionPty(directory, { cols: 80, rows: 24 })
    const exited = new Promise<void>(resolve => pty!.onExit(() => resolve()))
    pty.write(`bash -c 'trap "" HUP; printf "%s" $$ > "${directory}/job.pid"; exec sleep 60' >/dev/null 2>&1 &\r`)
    pid = await waitForPid(join(directory, 'job.pid'))
    expect(isRunning(pid)).toBe(true)
    pty.kill('SIGHUP')
    await Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Stop was not acknowledged.')), 5000))])
    // This assertion fails if shell exit is published before escalating the ignored HUP.
    expect(isRunning(pid)).toBe(false)
    pty = undefined
  } finally {
    pty?.kill('SIGKILL')
    if (pid && isRunning(pid)) { try { process.kill(pid, 'SIGKILL') } catch {} }
    if (previousShell === undefined) delete process.env.SHELL; else process.env.SHELL = previousShell
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)

test('losing the parent process closes bridge stdin and stops its background jobs', async () => {
  if (process.platform === 'win32') return
  const directory = await mkdtemp(join(tmpdir(), 'craft-terminal-parent-'))
  let pid: number | undefined
  const source = new URL('./node-pty.ts', import.meta.url).pathname
  const script = `import { spawnSessionPty } from ${JSON.stringify(source)}; const pty = await spawnSessionPty(${JSON.stringify(directory)}, {cols:80,rows:24}); pty.onData(()=>{}); pty.write(${JSON.stringify(`bash -c 'trap "" HUP; printf "%s" $$ > "${directory}/job.pid"; exec sleep 60' >/dev/null 2>&1 &\r`)}); await new Promise(()=>{});`
  const parent = spawnChild(process.execPath, ['-e', script], { env: { ...process.env, SHELL: '/bin/bash', HOME: directory }, stdio: 'ignore' })
  const closed = new Promise<void>(resolve => parent.on('close', () => resolve()))
  try {
    pid = await waitForPid(join(directory, 'job.pid'))
    expect(isRunning(pid)).toBe(true)
    parent.kill('SIGKILL')
    await closed
    await waitFor(() => !isRunning(pid!))
    expect(isRunning(pid)).toBe(false)
  } finally {
    parent.kill('SIGKILL')
    if (pid && isRunning(pid)) { try { process.kill(pid, 'SIGKILL') } catch {} }
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
