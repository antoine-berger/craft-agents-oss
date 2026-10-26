import { describe, expect, it, mock } from 'bun:test'
import type { LlmConnection } from '@craft-agent/shared/config'
import { SessionManager, createManagedSession } from './SessionManager.ts'

type ManagedSession = ReturnType<typeof createManagedSession>
type RetryHarness = {
  attemptAuthRetry(sessionId: string, managed: ManagedSession, workspaceId: string): boolean
  initializeManagedAgentAuth(managed: ManagedSession, connection: LlmConnection | null): Promise<void>
  sendEvent: ReturnType<typeof mock>
  sendMessage: ReturnType<typeof mock>
  setProcessing: ReturnType<typeof mock>
  monotonic(): number
}

function harness() {
  const manager = Object.create(SessionManager.prototype) as RetryHarness
  manager.sendEvent = mock(() => {})
  manager.sendMessage = mock(async () => {})
  manager.setProcessing = mock(() => {})
  manager.monotonic = () => 1
  const managed = createManagedSession({ id: 'auth-retry-test' }, {
    id: 'workspace', slug: 'workspace', name: 'Test', rootPath: '/unused-auth-retry-test', createdAt: 1,
  })
  managed.lastSentMessage = 'Please retry this message'
  managed.lastSentMessageIds = ['failed-user']
  managed.messages.push(
    { id: 'earlier', role: 'assistant', content: 'Keep this reply', timestamp: 1 },
    { id: 'failed-user', role: 'user', content: managed.lastSentMessage, timestamp: 2 },
  )
  return { manager, managed }
}

const nextImmediate = () => new Promise<void>(resolve => setImmediate(resolve))

describe('Claude account authentication before backend startup', () => {
  const connection: LlmConnection = {
    slug: 'account-a', name: 'Account A', providerType: 'anthropic', authType: 'oauth', createdAt: 1,
  }

  it('stops and tears down a missing account instead of inheriting another login', async () => {
    const { manager, managed } = harness()
    const disposed = mock(async () => {})
    const disconnected = mock(async () => {})
    const ready = mock(() => {})
    managed.agent = {
      postInit: async () => ({ authInjected: false, authWarning: 'Reconnect Account A' }),
      disposeForRestart: disposed,
      takePendingSteers: () => [],
    } as unknown as NonNullable<ManagedSession['agent']>
    managed.mcpPool = { disconnectAll: disconnected } as unknown as NonNullable<ManagedSession['mcpPool']>
    managed.agentReadyResolve = ready
    await expect(manager.initializeManagedAgentAuth(managed, connection)).rejects.toThrow('Reconnect Account A')
    expect(disposed).toHaveBeenCalledTimes(1)
    expect(disconnected).toHaveBeenCalledTimes(1)
    expect(ready).toHaveBeenCalledTimes(1)
    expect(managed.agent).toBeNull()
    expect(managed.mcpPool).toBeUndefined()
    expect(manager.sendMessage).not.toHaveBeenCalled()
  })

  it('keeps a successfully authenticated account ready for the model request', async () => {
    const { manager, managed } = harness()
    const disposed = mock(async () => {})
    const agent = {
      postInit: async () => ({ authInjected: true }), disposeForRestart: disposed,
    } as unknown as NonNullable<ManagedSession['agent']>
    managed.agent = agent
    await manager.initializeManagedAgentAuth(managed, connection)
    expect(managed.agent).toBe(agent)
    expect(disposed).not.toHaveBeenCalled()
  })

  it('discards a partially initialized agent when credential resolution throws', async () => {
    const { manager, managed } = harness()
    const disposed = mock(async () => {})
    managed.agent = {
      postInit: async () => { throw new Error('Credential store unavailable') },
      disposeForRestart: disposed, takePendingSteers: () => [],
    } as unknown as NonNullable<ManagedSession['agent']>
    await expect(manager.initializeManagedAgentAuth(managed, connection)).rejects.toThrow('Credential store unavailable')
    expect(disposed).toHaveBeenCalledTimes(1)
    expect(managed.agent).toBeNull()
  })
})

describe('auth retry runtime cleanup', () => {
  it('awaits agent, pool server and MCP cleanup before resending the message', async () => {
    const { manager, managed } = harness()
    const order: string[] = []
    const disconnected = Promise.withResolvers<void>()
    const takePendingSteers = mock(() => [])
    managed.agent = {
      takePendingSteers,
      disposeForRestart: async () => { order.push('agent') },
      dispose: mock(() => { throw new Error('must prefer disposeForRestart') }),
    } as unknown as NonNullable<ManagedSession['agent']>
    managed.poolServer = { stop: async () => { order.push('server') } } as NonNullable<ManagedSession['poolServer']>
    managed.mcpPool = {
      disconnectAll: async () => { order.push('pool'); await disconnected.promise },
    } as NonNullable<ManagedSession['mcpPool']>
    managed.envOverrides = { OLD_RUNTIME: 'true' }
    managed.backendRuntimeSignature = 'old-runtime'
    managed.backendRestartSignature = 'old-restart'
    managed.lastSentOptions = { hidden: true }

    expect(manager.attemptAuthRetry(managed.id, managed, managed.workspace.id)).toBe(true)
    await nextImmediate()
    const beforeDisconnect = {
      order: [...order],
      sends: manager.sendMessage.mock.calls.length,
      retryInProgress: managed.authRetryInProgress,
    }
    disconnected.resolve()
    await nextImmediate()

    expect(beforeDisconnect).toEqual({ order: ['agent', 'server', 'pool'], sends: 0, retryInProgress: true })
    expect(takePendingSteers).toHaveBeenCalledTimes(1)
    expect(managed.agent).toBeNull()
    expect(managed.poolServer).toBeUndefined()
    expect(managed.mcpPool).toBeUndefined()
    expect(managed.envOverrides).toBeUndefined()
    expect(managed.backendRuntimeSignature).toBeUndefined()
    expect(managed.backendRestartSignature).toBeUndefined()
    expect(managed.messages.map(message => message.id)).toEqual(['earlier'])
    expect(managed.authRetryInProgress).toBe(false)
    expect(manager.sendMessage).toHaveBeenCalledTimes(1)
    expect(manager.sendMessage).toHaveBeenCalledWith(
      managed.id, 'Please retry this message', undefined, undefined, managed.lastSentOptions, undefined, true,
    )
  })

  it('still disconnects the pool when legacy agent disposal or pool-server stop fails', async () => {
    const { manager, managed } = harness()
    const dispose = mock(() => { throw new Error('agent already stopped') })
    const stop = mock(async () => { throw new Error('server already stopped') })
    const disconnectAll = mock(async () => {})
    managed.agent = { dispose } as unknown as NonNullable<ManagedSession['agent']>
    managed.poolServer = { stop } as unknown as NonNullable<ManagedSession['poolServer']>
    managed.mcpPool = { disconnectAll } as unknown as NonNullable<ManagedSession['mcpPool']>

    expect(manager.attemptAuthRetry(managed.id, managed, managed.workspace.id)).toBe(true)
    await nextImmediate()

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(disconnectAll).toHaveBeenCalledTimes(1)
    expect(managed.mcpPool).toBeUndefined()
    expect(manager.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('does not initiate cleanup or another retry when the retry guard is set', async () => {
    const { manager, managed } = harness()
    managed.authRetryAttempted = true
    const dispose = mock(() => {})
    managed.agent = { dispose } as unknown as NonNullable<ManagedSession['agent']>

    expect(manager.attemptAuthRetry(managed.id, managed, managed.workspace.id)).toBe(false)
    await nextImmediate()

    expect(dispose).not.toHaveBeenCalled()
    expect(manager.sendMessage).not.toHaveBeenCalled()
  })
})
