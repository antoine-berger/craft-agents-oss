import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSession } from '@craft-agent/shared/sessions/storage'
import { SessionManager, createManagedSession, CLAUDE_RUNTIME_IDLE_TIMEOUT_MS } from './SessionManager'

describe('five-minute Claude runtime expiration', () => {
  let root: string
  let sm: SessionManager
  let internal: any
  let session: ReturnType<typeof createManagedSession>
  let agent: any
  let timers: Array<{ callback: () => void; unref: ReturnType<typeof mock> }>
  let timerSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'craft-idle-runtime-'))
    sm = new SessionManager(); internal = sm as any; sm.setEventSink(() => {})
    session = createManagedSession({ id: 'idle-chat', sdkSessionId: 'keep-sdk-id', workingDirectory: '/keep-worktree', projectId: 'keep-project' },
      { id: 'workspace', name: 'Fixture', rootPath: root, createdAt: 1 } as any, { messagesLoaded: true })
    session.messages.push({ id: 'user-1', role: 'user', content: 'Keep this question', timestamp: 1 },
      { id: 'answer-1', role: 'assistant', content: 'Keep this answer', timestamp: 2 })
    agent = { dispose: mock(() => {}), canReleaseIdleRuntime: () => true,
      // A persistent query reports processing even between turns; this must not prevent expiration.
      isProcessing: () => true, takePendingSteers: () => [] }
    session.agent = agent; internal.sessions.set(session.id, session)
    timers = []
    const original = globalThis.setTimeout
    timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number, ...args: any[]) => {
      if (delay !== CLAUDE_RUNTIME_IDLE_TIMEOUT_MS) return original(callback, delay, ...args)
      const timer = { callback, unref: mock(() => {}) }; timers.push(timer); return timer as any
    }) as any)
  })

  afterEach(async () => {
    internal.clearIdleRuntimeTimer(session)
    timerSpy.mockRestore()
    await SessionManager.prototype.flushSession.call(sm, session.id)
    rmSync(root, { recursive: true, force: true })
  })

  function arm() { internal.scheduleIdleRuntimeRelease(session); return session.idleRuntimeGeneration }
  async function expire(generation = arm()) { await internal.releaseIdleRuntime(session, agent, generation) }

  it('waits five minutes and creates no model request or conversation while waiting', () => {
    expect(CLAUDE_RUNTIME_IDLE_TIMEOUT_MS).toBe(300_000)
    arm(); expect(agent.dispose).not.toHaveBeenCalled(); expect(timers).toHaveLength(1)
    expect(timers[0]!.unref).toHaveBeenCalled(); expect(internal.sessions.size).toBe(1)
  })

  it('releases the runtime when the real scheduled callback fires', async () => {
    arm(); timers[0]!.callback()
    for (let i = 0; i < 100 && session.agent; i++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(agent.dispose).toHaveBeenCalledTimes(1); expect(session.agent).toBeNull()
  })

  it('flushes history before releasing only runtime resources and retains the SDK/project/worktree identity', async () => {
    const pool = { stop: mock(async () => {}), disconnectAll: mock(async () => {}) }
    session.poolServer = pool as any; session.mcpPool = pool as any
    agent.dispose.mockImplementation(() => {
      const saved = loadSession(root, session.id)!
      expect(saved.sdkSessionId).toBe('keep-sdk-id')
      expect(saved.messages.map(m => m.content)).toEqual(['Keep this question', 'Keep this answer'])
    })
    await expire()
    expect(agent.dispose).toHaveBeenCalledTimes(1); expect(pool.stop).toHaveBeenCalledTimes(1); expect(pool.disconnectAll).toHaveBeenCalledTimes(1)
    expect(session.agent).toBeNull(); expect(session.sdkSessionId).toBe('keep-sdk-id')
    expect(session.workingDirectory).toBe('/keep-worktree'); expect(session.projectId).toBe('keep-project')
    expect(internal.sessions.get(session.id)).toBe(session); expect(session.messages).toHaveLength(2)
  })

  it.each([
    { isProcessing: true }, { stopRequested: true }, { isArchived: true }, { isDeleting: true },
    { isRestoringCheckpoint: true }, { checkpointPendingSends: 1 }, { checkpointAsyncWriters: 1 },
    { messageQueue: [{ message: 'queued' }] }, { acceptedSteers: new Map([['s', {}]]) },
    { authRetryInProgress: true }, { autoRetryTimer: {} },
    { autoRetryPending: { committed: false, deadlineMs: Date.now() + 60_000 } },
    { pendingActivationResend: 'retry' }, { pendingHandoffSummary: Promise.resolve() },
    { isAsyncOperationOngoing: true }, { agentReadyResolve: () => {} },
    { pendingAuthRequestId: 'auth' }, { pendingAuthRequest: {} }, { sdkSessionId: undefined },
  ])('preserves a runtime while its session is not safely resumable/idle: %j', async overrides => {
    const generation = arm(); Object.assign(session, overrides)
    await expire(generation); expect(agent.dispose).not.toHaveBeenCalled()
  })

  it.each(['agent', 'workflow', 'shell', 'task', 'unknown'])('never cuts a running %s, including untracked work', async kind => {
    session.backgroundTaskRegistry.set('task', { taskId: 'task', startTime: 1, status: 'running', kind, untracked: true } as any)
    await expire(); expect(agent.dispose).not.toHaveBeenCalled()
    session.backgroundTaskRegistry.get('task')!.status = 'completed'
    await expire(); expect(agent.dispose).toHaveBeenCalledTimes(1)
  })

  it('protects permission prompts, agent preparation and runtime refreshes', async () => {
    internal.pendingPermissionRequests.set('permission', { sessionId: session.id })
    await expire(); expect(agent.dispose).not.toHaveBeenCalled(); internal.pendingPermissionRequests.clear()
    internal.agentPreparations.set(session.id, Promise.resolve(agent))
    await expire(); expect(agent.dispose).not.toHaveBeenCalled(); internal.agentPreparations.clear()
    internal.agentRefreshLocks.set(session.id, Promise.resolve())
    await expire(); expect(agent.dispose).not.toHaveBeenCalled(); internal.agentRefreshLocks.clear()
    await expire(); expect(agent.dispose).toHaveBeenCalledTimes(1)
  })

  it('does not expire another backend or a Claude runtime still executing SDK work', async () => {
    agent.canReleaseIdleRuntime = undefined; arm(); expect(timers).toHaveLength(0)
    await expire(); expect(agent.dispose).not.toHaveBeenCalled()
    agent.canReleaseIdleRuntime = () => false; await expire(); expect(agent.dispose).not.toHaveBeenCalled()
  })

  it('resets the deadline on activity and ignores a canceled timer callback', async () => {
    arm(); const canceled = timers[0]!
    await internal.processEvent(session, { type: 'status', message: 'Background update' })
    expect(timers).toHaveLength(2); canceled.callback()
    await Promise.resolve(); expect(agent.dispose).not.toHaveBeenCalled()
    internal.setProcessing(session, true)
    expect(session.idleRuntimeTimer).toBeUndefined()
    internal.setProcessing(session, false)
    expect(session.idleRuntimeTimer).toBeDefined()
  })

  it('gives priority to activity arriving while persistence is flushing', async () => {
    const gate = Promise.withResolvers<void>(); internal.flushSession = () => gate.promise
    const generation = arm(); const expiring = internal.releaseIdleRuntime(session, agent, generation)
    await Promise.resolve(); internal.scheduleIdleRuntimeRelease(session)
    gate.resolve(); await expiring; expect(agent.dispose).not.toHaveBeenCalled()
  })

  it('never closes the runtime if flushing history fails', async () => {
    internal.flushSession = async () => { throw new Error('Disk unavailable') }
    await expire(); expect(agent.dispose).not.toHaveBeenCalled(); expect(session.agent).toBe(agent)
  })

  it('serializes a concurrent runtime reader until teardown completes', async () => {
    const gate = Promise.withResolvers<void>(); const stopping = Promise.withResolvers<void>()
    session.poolServer = { stop: async () => { stopping.resolve(); await gate.promise } } as any
    const expiring = internal.releaseIdleRuntime(session, agent, arm()); await stopping.promise
    let resolved = false
    const reader = internal.getReadyManagedAgent(session).then((value: unknown) => { resolved = true; return value })
    await Promise.resolve(); expect(resolved).toBe(false)
    gate.resolve(); await expiring; expect(await reader).toBeNull()
    expect(session.sdkSessionId).toBe('keep-sdk-id')
  })

  it('ignores an obsolete dedup record after its activation retry already completed', async () => {
    session.autoRetryPending = { content: 'old', deadlineMs: Date.now() - 1, committed: false }
    await expire(); expect(agent.dispose).toHaveBeenCalledTimes(1)
  })
})
