import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { ensureRepositorySetup, resolveRepositorySetup, type RepositorySetupConfig } from './setup'

let root: string
let source: string
let checkout: string
let session: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-setup-'))
  source = join(root, 'source'); checkout = join(root, 'checkout'); session = join(root, 'session')
  for (const path of [source, checkout, session]) mkdirSync(path)
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
const input = () => ({ repositoryPath: source, worktreePath: checkout, sessionDirectory: session })
const state = () => JSON.parse(readFileSync(join(session, 'data/worktree-setup.json'), 'utf8'))
function config(value: RepositorySetupConfig) {
  mkdirSync(join(source, '.craft'), { recursive: true })
  writeFileSync(join(source, '.craft/setup.json'), JSON.stringify(value))
}

function startHost() {
  const module = fileURLToPath(new URL('./setup.ts', import.meta.url))
  const code = `import { ensureRepositorySetup } from ${JSON.stringify(module)}; await ensureRepositorySetup(${JSON.stringify(input())});`
  const process = spawn(globalThis.process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  process.stderr.on('data', data => { stderr += data })
  const exited = new Promise<{ code: number | null; stderr: string }>(resolve => process.once('close', code => resolve({ code, stderr })))
  return { process, exited }
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (existsSync(file)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Setup fixture did not start: ${file}`)
}

describe('repository setup', () => {
  test('prepares and verifies the checkout once, deduplicating concurrent callers durably', async () => {
    config({ command: 'printf x >> prepared; printf installed', verifyCommand: 'test -f prepared' })
    const [a, b] = await Promise.all([ensureRepositorySetup(input()), ensureRepositorySetup(input())])
    expect(a).toBe(b)
    expect(a.status).toBe('ready')
    expect(readFileSync(join(checkout, 'prepared'), 'utf8')).toBe('x')
    expect(readFileSync(a.logPath, 'utf8')).toContain('installed')
    expect((await ensureRepositorySetup(input())).attempt).toBe(1)
    expect(readFileSync(join(checkout, 'prepared'), 'utf8')).toBe('x')
    expect(existsSync(join(source, 'prepared'))).toBe(false)
  })

  test('a dependency lock change invalidates a successful setup', async () => {
    config({ command: 'printf x >> prepared' })
    writeFileSync(join(checkout, 'package-lock.json'), 'one')
    await ensureRepositorySetup(input())
    writeFileSync(join(checkout, 'package-lock.json'), 'two')
    expect((await ensureRepositorySetup(input())).attempt).toBe(2)
    expect(readFileSync(join(checkout, 'prepared'), 'utf8')).toBe('xx')
  })

  test('reads trusted source setup rather than a PR checkout override', async () => {
    config({ command: 'printf trusted > prepared' })
    mkdirSync(join(checkout, '.craft'))
    writeFileSync(join(checkout, '.craft/setup.json'), JSON.stringify({ command: 'printf unsafe > unsafe' }))
    await ensureRepositorySetup(input())
    expect(readFileSync(join(checkout, 'prepared'), 'utf8')).toBe('trusted')
    expect(existsSync(join(checkout, 'unsafe'))).toBe(false)
  })

  test('supports Conductor setup and an explicit project override', async () => {
    writeFileSync(join(source, 'conductor.json'), JSON.stringify({ scripts: { setup: ['printf one > prepared', 'printf two >> prepared'] } }))
    await ensureRepositorySetup(input())
    expect(readFileSync(join(checkout, 'prepared'), 'utf8')).toBe('onetwo')
    await ensureRepositorySetup({ ...input(), projectSetup: { command: 'printf project > prepared', verifyCommand: 'test -f prepared' } })
    expect(readFileSync(join(checkout, 'prepared'), 'utf8')).toBe('project')
  })

  test('fails visibly on readiness failure and permits retry in the same checkout', async () => {
    config({ command: 'printf installed > prepared', verifyCommand: 'test -f ready' })
    await expect(ensureRepositorySetup(input())).rejects.toThrow('Repository setup exited')
    expect(state().status).toBe('failed')
    writeFileSync(join(checkout, 'ready'), 'yes')
    expect((await ensureRepositorySetup(input())).status).toBe('ready')
    expect(state().attempt).toBe(2)
  })

  test('stops the active process group and can retry after cancellation', async () => {
    config({ command: 'printf started > started; sleep 10; printf unexpected > finished' })
    const controller = new AbortController()
    const running = ensureRepositorySetup({ ...input(), signal: controller.signal })
    for (let attempt = 0; attempt < 100 && !existsSync(join(checkout, 'started')); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(state().status).toBe('cancelled')
    expect(existsSync(join(checkout, 'finished'))).toBe(false)
    config({ command: 'printf recovered > prepared' })
    expect((await ensureRepositorySetup(input())).status).toBe('ready')
  })

  test('a failed command in a Conductor array prevents subsequent commands', async () => {
    writeFileSync(join(source, 'conductor.json'), JSON.stringify({ scripts: { setup: ['exit 12', 'printf unexpected > finished'] } }))
    await expect(ensureRepositorySetup(input())).rejects.toThrow('12')
    expect(existsSync(join(checkout, 'finished'))).toBe(false)
  })

  test('copies explicit environment files once without overwriting target files', async () => {
    writeFileSync(join(source, '.env'), 'local environment')
    config({ command: 'test -f .env', copyFiles: ['.env'] })
    await ensureRepositorySetup(input())
    expect(readFileSync(join(checkout, '.env'), 'utf8')).toBe('local environment')
    writeFileSync(join(checkout, '.env'), 'checkout environment')
    config({ command: 'test -f .env && true', copyFiles: ['.env'] })
    await ensureRepositorySetup(input())
    expect(readFileSync(join(checkout, '.env'), 'utf8')).toBe('checkout environment')
  })

  test('does not copy environment files through an escaping target symlink', async () => {
    const outside = join(root, 'outside'); mkdirSync(outside)
    writeFileSync(join(source, '.env'), 'local environment')
    symlinkSync(outside, join(checkout, 'escape'))
    config({ command: 'true', copyFiles: ['escape/nested/.env'] })
    mkdirSync(join(source, 'escape/nested'), { recursive: true })
    writeFileSync(join(source, 'escape/nested/.env'), 'private')
    await expect(ensureRepositorySetup(input())).rejects.toThrow('escapes')
    expect(existsSync(join(outside, 'nested'))).toBe(false)
  })

  test('missing config is explicitly skipped and malformed config is a durable failure', async () => {
    expect((await ensureRepositorySetup(input())).status).toBe('skipped')
    mkdirSync(join(source, '.craft'))
    writeFileSync(join(source, '.craft/setup.json'), '{ malformed')
    await expect(ensureRepositorySetup(input())).rejects.toThrow('Invalid JSON')
    expect(state().status).toBe('failed')
  })

  test('rejects unsafe copy paths before executing a setup command', async () => {
    config({ command: 'printf unexpected > finished', copyFiles: ['../escape'] })
    await expect(resolveRepositorySetup(input())).rejects.toThrow('relative')
    expect(existsSync(join(checkout, 'finished'))).toBe(false)
  })

  test('a server SIGKILL cancels its setup before a replacement server can run it', async () => {
    config({ command: 'printf started > started; sleep 0.6; printf x >> completed' })
    const original = startHost()
    await waitForFile(join(checkout, 'started'))
    original.process.kill('SIGKILL')
    await original.exited
    const replacement = startHost()
    const result = await replacement.exited
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(readFileSync(join(checkout, 'completed'), 'utf8')).toBe('x')
    expect(state().status).toBe('ready')
  }, 10_000)

  test('two live server processes share one checkout setup and its durable result', async () => {
    config({ command: 'printf started > started; sleep 0.4; printf x >> completed' })
    const first = startHost()
    await waitForFile(join(checkout, 'started'))
    const second = startHost()
    const [a, b] = await Promise.all([first.exited, second.exited])
    expect(a).toEqual({ code: 0, stderr: '' })
    expect(b).toEqual({ code: 0, stderr: '' })
    expect(readFileSync(join(checkout, 'completed'), 'utf8')).toBe('x')
    expect(state().attempt).toBe(1)
  }, 10_000)

  test('a killed supervisor leaves its command leased until that command is terminal', async () => {
    config({ command: 'test ! -e active; printf active > active; printf "$PPID" > supervisor; sleep 0.5; rm active; printf x >> completed' })
    const first = startHost()
    await waitForFile(join(checkout, 'supervisor'))
    const supervisor = Number(readFileSync(join(checkout, 'supervisor'), 'utf8'))
    expect(supervisor).toBeGreaterThan(1)
    process.kill(supervisor, 'SIGKILL')
    expect((await first.exited).code).not.toBe(0)
    const second = startHost()
    expect(await second.exited).toEqual({ code: 0, stderr: '' })
    expect(readFileSync(join(checkout, 'completed'), 'utf8')).toBe('xx')
    expect(state().status).toBe('ready')
  }, 10_000)
})
