import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupI18n } from '@craft-agent/shared/i18n'
import { getSessionFilePath, loadSession, sessionPersistenceQueue } from '@craft-agent/shared/sessions'
import { createManagedSession, SessionManager } from './SessionManager'

type Managed = ReturnType<typeof createManagedSession>
type Agent = NonNullable<Managed['agent']>
type Internals = {
  sessions: Map<string, Managed>
  sendEvent: ReturnType<typeof mock>
  getOrCreatePreparedAgent: ReturnType<typeof mock>
  persistSession(managed: Managed): void
  getOrCreateAgent(managed: Managed, checkpointMessageId?: string): Promise<Agent>
}
const env = { ...process.env, GIT_AUTHOR_NAME: 'Checkpoint Test', GIT_AUTHOR_EMAIL: 'checkpoint@example.invalid',
  GIT_COMMITTER_NAME: 'Checkpoint Test', GIT_COMMITTER_EMAIL: 'checkpoint@example.invalid' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
let root: string
let repository: string
let manager: SessionManager
let internals: Internals
let managed: Managed
const originalPath = process.env.PATH
beforeAll(() => setupI18n())
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'manager-checkpoints-')))
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin', 'gh'), '#!/bin/sh\nprintf "fixture-developer\\n"\n', { mode: 0o755 })
  process.env.PATH = `${join(root, 'bin')}:${originalPath}`
  repository = join(root, 'repo'); mkdirSync(repository)
  git(repository, 'init', '-b', 'main')
  writeFileSync(join(repository, 'code.txt'), 'initial\n')
  writeFileSync(join(repository, '.gitignore'), '.env\n')
  git(repository, 'add', '.'); git(repository, 'commit', '-m', 'initial')
  manager = new SessionManager()
  internals = manager as unknown as Internals
  internals.sendEvent = mock(() => {})
  // Actual public send/preparation/persistence/Git are real. Only the LLM boundary is replaced.
  internals.getOrCreatePreparedAgent = mock(async (chat: Managed) => {
    expect(loadSession(chat.workspace.rootPath, chat.id)?.messages.some(message => message.type === 'user')).toBe(true)
    const list = await manager.listSessionCheckpoints(chat.id)
    expect(list.checkpoints.length).toBeGreaterThan(0)
    throw new Error('Fixture stops at the backend boundary')
  })
  const workspace = { id: randomUUID(), name: 'fixture', slug: 'fixture', rootPath: join(root, 'workspace'), createdAt: 1 }
  mkdirSync(workspace.rootPath)
  managed = createManagedSession({ id: randomUUID(), name: 'Existing fixture title',
    workingDirectory: repository, sdkCwd: repository,
    worktree: { repositoryPath: repository, baseBranch: 'main' }, projectId: 'existing-project',
  }, workspace, { messagesLoaded: true })
  internals.sessions.set(managed.id, managed)
})
afterEach(async () => {
  process.env.PATH = originalPath
  for (const chat of internals.sessions.values()) { await manager.flushSession(chat.id); sessionPersistenceQueue.cancel(chat.id) }
  rmSync(root, { recursive: true, force: true })
})
async function send(text: string) {
  let ack = ''
  await manager.sendMessage(managed.id, text, undefined, undefined, undefined, undefined, undefined, id => {
    ack = id
    expect(loadSession(managed.workspace.rootPath, managed.id)?.messages.some(message => message.id === id)).toBe(true)
  })
  expect(ack).not.toBe('')
  return ack
}
async function persist() { internals.persistSession(managed); await manager.flushSession(managed.id) }
async function twoTurns() {
  const first = await send('first request')
  managed.messages.push({ id: 'assistant-one', role: 'assistant', content: 'retained answer', timestamp: Date.now() })
  writeFileSync(join(managed.workingDirectory!, 'code.txt'), 'before second\n')
  await persist()
  const second = await send('second request')
  const checkpoint = (await manager.listSessionCheckpoints(managed.id)).checkpoints.find(item => item.userMessageId === second)!
  expect(checkpoint).toBeDefined()
  return { first, second, checkpoint }
}
describe('SessionManager checkpoint integration', () => {
  it('captures first accepted visible send before backend construction, idempotently and without changing source checkout', async () => {
    const user = await send('implement feature')
    const checkpoints = await manager.listSessionCheckpoints(managed.id)
    expect(checkpoints.checkpoints.map(checkpoint => checkpoint.userMessageId)).toEqual([user])
    expect(readFileSync(join(repository, 'code.txt'), 'utf8')).toBe('initial\n')
    writeFileSync(join(managed.workingDirectory!, 'code.txt'), 'later\n')
    await internals.getOrCreateAgent(managed, user).catch(() => {})
    const restored = await manager.restoreSessionCheckpoint(managed.id, checkpoints.checkpoints[0]!.id)
    expect(restored.recovery.kind).toBe('recovery')
    expect(managed.messages).toEqual([])
    expect(readFileSync(join(managed.workingDirectory!, 'code.txt'), 'utf8')).toBe('initial\n')
  }, 30_000)

  it('restores code + retained chat, discards SDK future and broadcasts full snapshot; recovery restores newer state', async () => {
    const { first, second, checkpoint } = await twoTurns()
    const path = managed.workingDirectory!
    writeFileSync(join(path, 'code.txt'), 'future code\n')
    writeFileSync(join(path, 'future.txt'), 'recover me\n')
    writeFileSync(join(path, '.env'), 'ignored credential\n')
    git(path, 'add', 'code.txt'); git(path, 'commit', '-m', 'future commit')
    managed.messages.push({ id: 'assistant-two', role: 'assistant', content: 'future answer', timestamp: Date.now() })
    managed.sdkSessionId = 'future-sdk'
    managed.branchFromSdkSessionId = 'future-parent'
    managed.branchFromSdkTurnId = 'future-anchor'
    managed.piSdkMessageToCraftMessage = new Map([['future', 'assistant-two']])
    const dispose = mock(async () => {})
    managed.agent = { disposeForRestart: dispose, takePendingSteers: () => [], isProcessing: () => false } as unknown as Agent
    await persist()
    const result = await manager.restoreSessionCheckpoint(managed.id, checkpoint.id)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(managed.messages.map(message => message.id)).toEqual([first, 'assistant-one'])
    expect(managed.sdkSessionId).toBeUndefined()
    expect(managed.branchFromSdkSessionId).toBeUndefined()
    expect(managed.piSdkMessageToCraftMessage.size).toBe(0)
    expect(managed.agent).toBeNull()
    expect(managed.transferredSessionSummary).toContain('retained answer')
    expect(managed.transferredSessionSummary).not.toContain('future answer')
    expect(loadSession(managed.workspace.rootPath, managed.id)?.transferredSessionSummary).toContain('retained answer')
    expect(managed.projectId).toBe('existing-project')
    expect(readFileSync(join(path, 'code.txt'), 'utf8')).toBe('before second\n')
    expect(readFileSync(join(path, '.env'), 'utf8')).toBe('ignored credential\n')
    const events = internals.sendEvent.mock.calls.map(call => call[0])
    const event = events.findLast(event => event.type === 'session_restored')
    expect(event.session.messages.map((message: { id: string }) => message.id)).toEqual([first, 'assistant-one'])
    await manager.restoreSessionCheckpoint(managed.id, result.recovery.id)
    expect(readFileSync(join(path, 'code.txt'), 'utf8')).toBe('future code\n')
    expect(readFileSync(join(path, 'future.txt'), 'utf8')).toBe('recover me\n')
    expect(managed.messages.map(message => message.id)).toEqual([first, 'assistant-one', second, 'assistant-two'])
    expect(managed.sdkSessionId).toBeUndefined()
    expect(managed.transferredSessionSummary).toContain('future answer')
    expect(internals.getOrCreatePreparedAgent).toHaveBeenCalledTimes(2)
  }, 30_000)

  it('rejects send/delete during runtime teardown and rejects other checkout writers, pending send and title operations', async () => {
    const { checkpoint } = await twoTurns()
    const child = createManagedSession({ id: randomUUID(), parentSessionId: managed.id,
      workingDirectory: managed.workingDirectory, sdkCwd: managed.sdkCwd }, managed.workspace, { messagesLoaded: true })
    internals.sessions.set(child.id, child)
    child.isProcessing = true
    await expect(manager.restoreSessionCheckpoint(managed.id, checkpoint.id)).rejects.toThrow('Stop running')
    child.isProcessing = false
    child.backgroundTaskRegistry.set('task', { status: 'running', kind: 'shell' } as never)
    await expect(manager.restoreSessionCheckpoint(managed.id, checkpoint.id)).rejects.toThrow('Stop running')
    child.backgroundTaskRegistry.clear()
    managed.checkpointPendingSends = 1
    await expect(manager.restoreSessionCheckpoint(managed.id, checkpoint.id)).rejects.toThrow('Stop running')
    managed.checkpointPendingSends = 0
    managed.checkpointAsyncWriters = 1
    await expect(manager.restoreSessionCheckpoint(managed.id, checkpoint.id)).rejects.toThrow('Stop running')
    managed.checkpointAsyncWriters = 0
    let release!: () => void
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    managed.agent = { takePendingSteers: () => [], isProcessing: () => false,
      disposeForRestart: async () => { entered(); await new Promise<void>(resolve => { release = resolve }) },
    } as unknown as Agent
    const restore = manager.restoreSessionCheckpoint(managed.id, checkpoint.id)
    await ready
    await expect(manager.sendMessage(managed.id, 'racing message')).rejects.toThrow('restoration')
    await expect(manager.sendMessage(child.id, 'racing child')).rejects.toThrow('restored')
    await expect(manager.deleteSession(managed.id)).rejects.toThrow('restoration')
    release(); await restore
    expect(managed.isRestoringCheckpoint).toBe(false)
    expect(loadSession(managed.workspace.rootPath, managed.id)?.messages.some(message => message.content === 'racing message')).toBe(false)
  }, 30_000)

  it('never captures incidental getAgent/title preparations or hidden nudges', async () => {
    await send('visible request')
    const before = await manager.listSessionCheckpoints(managed.id)
    await internals.getOrCreateAgent(managed).catch(() => {})
    await manager.sendMessage(managed.id, 'hidden wakeup', [], [], { hidden: true })
    expect((await manager.listSessionCheckpoints(managed.id)).checkpoints).toEqual(before.checkpoints)
    const raw = readFileSync(getSessionFilePath(managed.workspace.rootPath, managed.id), 'utf8')
    expect(raw).toContain('hidden wakeup')
  }, 30_000)
})
