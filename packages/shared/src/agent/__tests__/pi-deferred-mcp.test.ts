import { afterEach, describe, expect, it, mock } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'
import { MCP_INVOKE_TOOL, MCP_SEARCH_TOOL } from '../../mcp/deferred-tool-catalog.ts'

const SESSION = 'pi-deferred-mcp'
const agents: PiAgent[] = []
function harness(mode: 'safe' | 'ask' | 'allow-all' = 'allow-all', policy?: BackendConfig['toolPolicy']) {
  initializeModeState(SESSION, mode)
  const defs = [
    { name: 'mcp__linear__list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'mcp__linear__delete_issue', description: 'Delete issue', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
  ]
  const pool = { getProxyToolDefs: () => defs, getSourceFeatures: () => undefined, disconnectAll: async () => {}, isProxyTool: (name: string) => defs.some(def => def.name === name), callTool: mock(async () => ({ content: 'through real pool guard', isError: false })) }
  const agent = new PiAgent({ provider: 'pi', workspace: { id: 'ws', name: 'Test', rootPath: '/tmp/pi-deferred-ws' },
    session: { id: SESSION, workspaceRootPath: '/tmp/pi-deferred-ws', createdAt: 0, lastUsedAt: 0 }, isHeadless: true, mcpPool: pool, toolPolicy: policy } as unknown as BackendConfig)
  agents.push(agent)
  const internal = agent as any
  const sent: any[] = []
  internal.send = (message: any) => { sent.push(message) }
  internal.emitAutomationEvent = async () => {}
  internal.sourceManager.getActiveSlugs = () => new Set(['linear'])
  internal.sourceManager.getAllSources = () => [{ config: { slug: 'linear' } }]
  internal.prerequisiteManager.checkPrerequisites = mock(() => ({ allowed: true }))
  return { agent, internal, sent, pool }
}
afterEach(() => { agents.splice(0).forEach(agent => agent.destroy()); cleanupModeState(SESSION) })
const invoke = (name: string, args: Record<string, unknown> = {}) => ({ requestId: 'pre-a', toolCallId: 'call-a', toolName: MCP_INVOKE_TOOL, input: { tool_name: name, arguments: args } })

describe('Pi deferred MCP security boundaries', () => {
  it('registers only discovery/invoke, not all source schemas', () => {
    const { internal, sent } = harness()
    internal.registerPoolToolsWithSubprocess()
    expect(sent.at(-1).tools.map((tool: any) => tool.name)).toEqual([MCP_SEARCH_TOOL, MCP_INVOKE_TOOL])
  })
  it('blocks a real write in Explore before invoking anything', async () => {
    const { internal, sent, pool } = harness('safe')
    await internal.handlePreToolUseRequest(invoke('mcp__linear__delete_issue', { id: 'a' }))
    expect(sent.at(-1).action).toBe('block')
    await internal.handleToolExecuteRequest({ requestId: 'exec-a', toolCallId: 'call-a', toolName: MCP_INVOKE_TOOL, args: { tool_name: 'mcp__linear__delete_issue', arguments: { id: 'a' } } })
    expect(sent.at(-1).result.isError).toBe(true)
    expect(pool.callTool).not.toHaveBeenCalled()
  })
  it('asks for the actual write name and cannot execute a denied approval', async () => {
    const { agent, internal, sent, pool } = harness('ask')
    const names: string[] = []
    agent.onPermissionRequest = request => { names.push(request.toolName); agent.respondToPermission(request.requestId, false, false) }
    await internal.handlePreToolUseRequest(invoke('mcp__linear__delete_issue', { id: 'a' }))
    expect(names).toEqual(['mcp__linear__delete_issue'])
    expect(sent.at(-1).action).toBe('block')
    expect(pool.callTool).not.toHaveBeenCalled()
  })
  it('passes the real source name/args into host policy and prerequisites', async () => {
    const policy = mock((name: string, input: Record<string, unknown>) => name === 'mcp__linear__list_issues' && input.query === 'private' ? 'Role policy denied' : null)
    const { internal, sent, pool } = harness('allow-all', policy)
    await internal.handlePreToolUseRequest(invoke('mcp__linear__list_issues', { query: 'private' }))
    expect(sent.at(-1)).toMatchObject({ action: 'block', reason: 'Role policy denied' })
    expect(policy).toHaveBeenCalledWith('mcp__linear__list_issues', { query: 'private' })
    internal.prerequisiteManager.checkPrerequisites = mock((name: string) => ({ allowed: false, blockReason: `Read guide for ${name}` }))
    await internal.handlePreToolUseRequest(invoke('mcp__linear__list_issues', { query: 'public' }))
    expect(sent.at(-1).reason).toContain('Read guide for mcp__linear__list_issues')
    expect(pool.callTool).not.toHaveBeenCalled()
  })
  it('dispatches only final approved args through the real pool and carries host result identity', async () => {
    const { internal, sent, pool } = harness()
    await internal.handlePreToolUseRequest(invoke('mcp__linear__list_issues', { query: 'public', _intent: 'Find issues' }))
    const approved = sent.at(-1).input
    expect(approved).toEqual({ tool_name: 'mcp__linear__list_issues', arguments: { query: 'public' } })
    await internal.handleToolExecuteRequest({ requestId: 'exec-a', toolCallId: 'call-a', toolName: MCP_INVOKE_TOOL, args: approved })
    expect(pool.callTool).toHaveBeenCalledWith('mcp__linear__list_issues', { query: 'public' }, { intent: 'Find issues' })
    expect(sent.at(-1).result.canonicalTool).toEqual({ name: 'mcp__linear__list_issues', input: { query: 'public' } })
    await internal.handleToolExecuteRequest({ requestId: 'exec-b', toolCallId: 'call-a', toolName: MCP_INVOKE_TOOL, args: approved })
    expect(sent.at(-1).result.isError).toBe(true)
    expect(pool.callTool).toHaveBeenCalledTimes(1)
  })
  it('keeps discovery read-only and rejects unknown/disconnected identities', async () => {
    const { internal, sent, pool } = harness('safe')
    await internal.handleToolExecuteRequest({ requestId: 'search', toolName: MCP_SEARCH_TOOL, args: { query: 'issue' } })
    expect(JSON.parse(sent.at(-1).result.content).tools).toHaveLength(2)
    expect(pool.callTool).not.toHaveBeenCalled()
    await internal.handlePreToolUseRequest(invoke('mcp__session__call_llm', {}))
    expect(sent.at(-1).action).toBe('block')
  })
})
