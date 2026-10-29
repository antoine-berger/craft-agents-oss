import { beforeEach, afterEach, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from './SessionManager'
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
let sm: any, source: any, dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'craft-dispatch-'))
  sm = new SessionManager(); sm.setEventSink(() => {})
  source = add('pilot'); add('a'); add('b')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
function add(id: string, workspaceId = 'workspace') {
  const session = createManagedSession({ id, name: id }, { id: workspaceId, name: 'Fixture', rootPath: dir, createdAt: 1 } as any, { messagesLoaded: true })
  sm.sessions.set(id, session); return session
}
it('fans out to different chats and serializes a repeated destination only until receipt', async () => {
  const starts: string[] = [], acks = new Map<string, () => void>(), finishes: (() => void)[] = []
  sm.sendMessage = (id: string, text: string, _a: unknown, _b: unknown, _c: unknown, _d: unknown, _e: unknown, ack: (id: string) => void) => {
    starts.push(text)
    const target = sm.sessions.get(id)
    acks.set(text, () => { target.messages.push({ id: text, role: 'user', content: text, isQueued: target.isProcessing }); target.isProcessing = true; ack(text) })
    return new Promise<void>(resolve => { finishes.push(resolve) })
  }
  const first = sm.deliverAgentMessage(source, 'a', 'a1')
  const second = sm.deliverAgentMessage(source, 'a', 'a2')
  const other = sm.deliverAgentMessage(source, 'b', 'b1')
  await tick(); expect(starts).toEqual(['a1', 'b1'])
  acks.get('b1')!(); expect((await other).delivery).toBe('delivered')
  acks.get('a1')!(); await first; await tick()
  expect(starts).toEqual(['a1', 'b1', 'a2'])
  acks.get('a2')!(); expect(await second).toMatchObject({ delivery: 'queued', messageId: 'a2' })
  expect(sm.agentMessageDispatches.size).toBe(0)
  finishes.forEach(finish => finish())
})
it('does not poison a destination after a failed send', async () => {
  let count = 0
  sm.sendMessage = async (_id: string, _text: string, _a: unknown, _b: unknown, _c: unknown, _d: unknown, _e: unknown, ack: (id: string) => void) => {
    if (++count === 1) throw Error('disk failure')
    ack('second')
  }
  const first = sm.deliverAgentMessage(source, 'a', 'first')
  const next = sm.deliverAgentMessage(source, 'a', 'next')
  await expect(first).rejects.toThrow('disk failure')
  expect((await next).messageId).toBe('second')
})
it('rechecks parent stop, archive and workspace boundaries before a delayed dispatch', async () => {
  let ack!: (id: string) => void, calls = 0
  sm.sendMessage = (...args: any[]) => { calls++; ack = args[7]; return new Promise<void>(() => {}) }
  const active = sm.deliverAgentMessage(source, 'a', 'first')
  const delayed = sm.deliverAgentMessage(source, 'a', 'cancel me')
  await tick(); source.stopEpoch = 1; ack('first'); await active
  await expect(delayed).rejects.toThrow('stopped'); expect(calls).toBe(1)
  sm.sessions.get('a').isArchived = true
  await expect(sm.deliverAgentMessage(source, 'a', 'archived')).rejects.toThrow('archived')
  add('foreign', 'other-workspace')
  await expect(sm.deliverAgentMessage(source, 'foreign', 'no')).rejects.toThrow('workspace')
})
it('a spawned chat waits for its first durable receipt, not its model completion', async () => {
  let ack!: (id: string) => void, received = false
  sm.createSession = async () => { const child = add('child'); return { id: child.id, name: child.name } }
  sm.sendMessage = (...args: any[]) => { ack = args[7]; return new Promise<void>(() => {}) }
  const result = sm.spawnIndependentSession('pilot', { prompt: '/ship-plan ISSUE-1', repository: { kind: 'local', gitDir: '/fixture', name: 'repo' } })
  result.then(() => { received = true })
  await tick(); expect(received).toBe(false)
  ack('first-message'); expect(await result).toMatchObject({ sessionId: 'child', status: 'started' })
})
it('a failed first send identifies the already-created chat instead of hiding it', async () => {
  sm.createSession = async () => ({ id: 'created-but-not-started' })
  sm.sendMessage = async () => { throw Error('worktree unavailable') }
  const result = sm.spawnIndependentSession('pilot', { prompt: 'plan', repository: { kind: 'local', gitDir: '/fixture', name: 'repo' } })
  try { await result; throw Error('should fail') }
  catch (error: any) { expect(error.sessionId).toBe('created-but-not-started'); expect(error.message).toContain('worktree unavailable') }
})

function holdTitleFlush() {
  const target = sm.sessions.get('a'); target.name = undefined
  for (const method of ['clearIdleRuntimeTimer', 'resumeBackgroundTurn', 'scheduleIdleRuntimeRelease', 'persistSession', 'applyAutoLabelMatches']) sm[method] = () => {}
  sm.assertNoCheckpointRestore = async () => {}; sm.ensureMessagesLoaded = async () => {}
  sm.decisionFeatureActive = () => false; sm.withCheckpointWriter = async () => {}; sm.startPreTurnDecisions = () => null
  // Stop before the backend is created: this test cannot call a model.
  sm.syncAutomaticSessionSources = () => new Promise<void>(() => {})
  sm.setProcessing = (managed: any, value: boolean) => { managed.isProcessing = value }
  let release!: () => void, entered!: () => void, count = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const holding = new Promise<void>(resolve => { entered = resolve })
  sm.flushSession = async () => { if (++count === 2) { entered(); await gate } }
  return { target, holding, release: () => release() }
}
it('does not release a fresh-chat receipt during its title flush and queues the next message', async () => {
  const fixture = holdTitleFlush(); let received = false
  const first = sm.deliverAgentMessage(source, 'a', 'FIRST').then((value: unknown) => { received = true; return value })
  await fixture.holding; expect(received).toBe(false)
  fixture.release(); await first
  expect(fixture.target.isProcessing).toBe(true)
  expect((await sm.deliverAgentMessage(source, 'a', 'SECOND')).delivery).toBe('queued')
  expect(fixture.target.messageQueue).toHaveLength(1)
  expect(fixture.target.processingGeneration).toBe(1)
})
it('Stop during a fresh title flush neither accepts nor retains the canceled prompt', async () => {
  const fixture = holdTitleFlush()
  const first = sm.deliverAgentMessage(source, 'a', 'Do not run')
  await fixture.holding; await sm.cancelProcessing('a'); fixture.release()
  await expect(first).rejects.toThrow('stopped')
  expect(fixture.target.messages.some((message: any) => message.role === 'user')).toBe(false)
  expect(fixture.target.isProcessing).toBe(false)
})
