import { describe, expect, it, mock } from 'bun:test'
import { ClaudeAgent, claudeThinkingKey } from '../claude-agent'
import { SourceManager } from '../core/source-manager'
import { createPushableInputStream } from '../backend/claude/persistent-input'

const thinking = { thinking: { type: 'adaptive' as const }, effort: 'high' as const }
const sdkServer = (name: string) => ({ type: 'sdk', name, instance: { name } })
function fixture() {
  const tools: Record<string, any[]> = { session: [] }
  let configured: Record<string, any> = { session: sdkServer('session') }
  const states: Record<string, string> = { session: 'connected' }
  const sourceManager = new SourceManager()
  sourceManager.updateActiveState([], [], ['linear'])
  const live = {
    mcpServerStatus: mock(async () => Object.keys(configured).map(name => ({ name, status: states[name] ?? 'connected' }))),
    setMcpServers: mock(async (next: Record<string, any>) => {
      const added = Object.keys(next).filter(name => !(name in configured))
      const removed = Object.keys(configured).filter(name => !(name in next))
      configured = { ...next }
      return { added, removed, errors: {} }
    }),
    reconnectMcpServer: mock(async (name: string) => { states[name] = 'connected' }),
    applyFlagSettings: async () => {}, setMaxThinkingTokens: async () => {},
  }
  const input = createPushableInputStream<any>(); const sent: any[] = []
  const agent = Object.assign(Object.create(ClaudeAgent.prototype), {
    config: { session: { id: 'existing-chat' }, mcpPool: { getTools: (name: string) => tools[name] ?? [] } },
    currentQuery: live, persistentInput: { ...input, push: (message: any) => sent.push(message) },
    persistentThinkingKey: claudeThinkingKey(thinking), pendingBackgroundTurns: [],
    sourceManager, _currentTurnUserMessage: 'owner request',
  }) as any
  agent.persistentMcpServers = { ...configured }; agent.persistentMcpKeys = agent.mcpServerKeys(configured)
  return { agent, live, tools, states, sent, sourceManager, sessionServer: configured.session }
}
const prompt = () => ({ type: 'user', message: { role: 'user', content: 'owner request' } })

describe('live Claude connector synchronization', () => {
  it('adds recovered tools before the next prompt in the same query, and keeps session tools', async () => {
    const f = fixture();f.tools.linear = [{ name: 'list_issues', inputSchema: { type: 'object' } }]
    const desired = { session: sdkServer('session'), linear: sdkServer('linear') }
    let formattedAfterSync = false
    await f.agent.beginPersistentTurn(() => { formattedAfterSync = f.sourceManager.isSourceActive('linear');return prompt() }, { mcpServers: desired }, thinking)
    expect(f.agent.currentQuery).toBe(f.live)
    expect(f.live.setMcpServers).toHaveBeenCalledTimes(1)
    expect(f.live.setMcpServers.mock.calls[0]![0].session).toBe(f.sessionServer)
    expect(formattedAfterSync).toBe(true)
    expect(f.sent).toHaveLength(1)
    await f.agent.syncPersistentMcpServers({ session: sdkServer('session'), linear: sdkServer('linear') })
    expect(f.live.setMcpServers).toHaveBeenCalledTimes(1)
  })

  it('removes revoked connectors and replaces only a changed tool schema', async () => {
    const f = fixture();f.tools.linear = [{ name: 'old', inputSchema: {} }]
    await f.agent.syncPersistentMcpServers({ session: f.sessionServer, linear: sdkServer('linear') })
    f.tools.linear = [{ name: 'new', inputSchema: { type: 'object' } }]
    await f.agent.syncPersistentMcpServers({ session: sdkServer('session'), linear: sdkServer('linear') })
    const calls = f.live.setMcpServers.mock.calls
    expect(Object.keys(calls[1]![0])).toEqual(['session'])
    expect(calls[2]![0].linear).toBeTruthy()
    expect(calls[2]![0].session).toBe(f.sessionServer)
    await f.agent.syncPersistentMcpServers({ session: sdkServer('session') })
    expect(f.sourceManager.isSourceActive('linear')).toBe(false)
  })

  it('reconnects a failed SDK server even when the catalog has not changed', async () => {
    const f = fixture();await f.agent.syncPersistentMcpServers({ session: f.sessionServer, linear: sdkServer('linear') })
    f.states.linear = 'failed';await f.agent.syncPersistentMcpServers({ session: f.sessionServer, linear: sdkServer('linear') })
    expect(f.live.reconnectMcpServer).toHaveBeenCalledWith('linear')
    expect(f.live.setMcpServers).toHaveBeenCalledTimes(1)
    expect(f.sourceManager.isSourceActive('linear')).toBe(true)
  })

  it('keeps a failed connector visibly unavailable, then recovers on a later turn', async () => {
    const f = fixture();f.states.linear = 'failed'
    f.live.reconnectMcpServer.mockImplementation(async () => { throw Error('offline') })
    await f.agent.beginPersistentTurn(prompt, { mcpServers: { session: f.sessionServer, linear: sdkServer('linear') } }, thinking)
    expect(f.sourceManager.isSourceActive('linear')).toBe(false)
    expect(f.sourceManager.formatSourceState()).toContain('linear (no tools)')
    expect(f.sent).toHaveLength(1)
    f.live.reconnectMcpServer.mockImplementation(async (name: string) => { f.states[name] = 'connected' })
    await f.agent.syncPersistentMcpServers({ session: f.sessionServer, linear: sdkServer('linear') })
    expect(f.sourceManager.isSourceActive('linear')).toBe(true)
  })

  it('waits for a pending SDK handshake before rendering the source block', async () => {
    const f = fixture();let reads = 0
    f.live.mcpServerStatus.mockImplementation(async () => ++reads < 3
      ? [{ name: 'session', status: 'connected' }, { name: 'linear', status: 'pending' }]
      : [{ name: 'session', status: 'connected' }, { name: 'linear', status: 'connected' }])
    await f.agent.beginPersistentTurn(() => {
      expect(f.sourceManager.isSourceActive('linear')).toBe(true)
      return prompt()
    }, { mcpServers: { session: f.sessionServer, linear: sdkServer('linear') } }, thinking)
    expect(f.sent).toHaveLength(1)
    expect(reads).toBeGreaterThanOrEqual(3)
  })

  it('never sends a prompt or restores old connector state after Stop during synchronization', async () => {
    const f = fixture();let release!: () => void
    f.live.setMcpServers.mockImplementation(async () => { await new Promise<void>(r => { release = r });return { added: ['linear'], removed: [], errors: {} } })
    const pending = f.agent.beginPersistentTurn(prompt, { mcpServers: { session: f.sessionServer, linear: sdkServer('linear') } }, thinking)
    await new Promise(r => setTimeout(r, 0));f.agent.currentQuery = null;f.agent.persistentInput = null;release()
    await expect(pending).rejects.toThrow('Query closed')
    expect(f.sent).toHaveLength(0)
  })
})
