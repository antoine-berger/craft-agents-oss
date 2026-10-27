import { describe, expect, it, mock } from 'bun:test'
import { CliProxyManager, publicAccounts } from './manager'

describe('integrated account proxy boundaries', () => {
  it('exposes only account labels/status and strips tokens, ID claims, file paths and unrelated providers', () => {
    const result = publicAccounts([
      { name: 'account.json', type: 'claude', email: 'a@example.invalid', status: 'active', disabled: false,
        access_token: 'secret-access', refresh_token: 'secret-refresh', id_token: { private: true }, path: '/private/auth.json' },
      { name: 'other.json', type: 'gemini', access_token: 'secret-other' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]?.provider).toBe('claude')
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('/private')
    expect(JSON.stringify(result)).not.toContain('id_token')
  })

  function harness() {
    const manager = Object.create(CliProxyManager.prototype) as CliProxyManager
    const internal = manager as unknown as Record<string, any>
    internal.pending = new Map()
    internal.initialize = async () => {}
    internal.status = async () => ({ enabled: true, running: true, accounts: [], models: [] })
    internal.management = mock(async () => ({ url: 'https://claude.ai/oauth/authorize?state=bound-state', state: 'bound-state' }))
    return { manager, internal }
  }

  it('binds account sign-in to the initiating client and rejects unsolicited callbacks', async () => {
    const { manager, internal } = harness()
    await manager.command({ action: 'startOAuth', provider: 'claude' }, 'window-a')
    await expect(manager.command({ action: 'completeOAuth', state: 'bound-state', code: 'code' }, 'window-b')).rejects.toThrow('expired')
    expect(internal.management).toHaveBeenCalledTimes(1)
    await manager.command({ action: 'completeOAuth', state: 'bound-state', code: 'code' }, 'window-a')
    expect(internal.management).toHaveBeenCalledTimes(2)
  })

  it('refuses unexpected authentication destinations before exposing a URL', async () => {
    const { manager, internal } = harness()
    internal.management = async () => ({ url: 'https://attacker.invalid/login', state: 'state' })
    await expect(manager.command({ action: 'startOAuth', provider: 'claude' }, 'window-a')).rejects.toThrow('Unexpected sign-in')
    expect(internal.pending.size).toBe(0)
  })
})

describe('CLIProxyAPI connector relay', () => {
  function relayHarness() {
    const manager = Object.create(CliProxyManager.prototype) as CliProxyManager
    const internal = manager as unknown as Record<string, any>
    internal.routedMcpRequests = 0
    internal.connectorAccount = async () => ({ id: 'claude-owned.json' })
    internal.management = async () => ({ files: [{ name: 'claude-owned.json', type: 'claude', auth_index: 'private-index' }] })
    internal.request = mock(async () => ({ status_code: 200, header: {}, body: '{}' }))
    return { manager, internal }
  }

  it('uses the proxy credential placeholder only against fixed Anthropic endpoints', async () => {
    const { manager, internal } = relayHarness()
    await manager.relayConnector('claude-owned.json', 'mcpsrv_test', 'POST', { Authorization: 'untrusted', Cookie: 'not-forwarded', 'Mcp-Session-Id': 'session' }, JSON.stringify({ literal: '$TOKEN$' }))
    const [path, management, method, body] = internal.request.mock.calls[0]
    expect(path).toBe('/requests/api-call')
    expect(management).toBe(true)
    expect(method).toBe('POST')
    expect(body.url).toBe('https://mcp-proxy.anthropic.com/v1/mcp/mcpsrv_test')
    expect(body.header.Authorization).toBe('Bearer $TOKEN$')
    expect(body.header.Cookie).toBeUndefined()
    expect(body.header['Mcp-Session-Id']).toBe('session')
    expect(body.data).not.toContain('$TOKEN$')
    expect(JSON.parse(body.data).literal).toBe('$TOKEN$')
    expect(internal.routedMcpRequests).toBe(1)
    await expect(manager.relayConnector('other-account', 'mcpsrv_test', 'POST')).rejects.toThrow('account changed')
    await expect(manager.relayConnector('claude-owned.json', '../other-host', 'POST')).rejects.toThrow('identity')
    expect(internal.request).toHaveBeenCalledTimes(1)
  })

  it('preserves the custom relay through the real MCP pool, handshake and tool call', async () => {
    const { McpClientPool } = await import('@craft-agent/shared/mcp/mcp-pool')
    const { manager, internal } = relayHarness()
    const messages: string[] = []
    internal.relayConnector = async (_account: string, _server: string, method: string, headers: Record<string, string>, body: string) => {
      expect(headers['X-Mcp-Client-Session-Id']).toBeTruthy()
      if (method === 'DELETE') return { status_code: 204, header: {}, body: '' }
      const message = JSON.parse(body)
      messages.push(message.method)
      if (message.id === undefined) return { status_code: 202, header: {}, body: '' }
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-03-26', serverInfo: { name: 'relay-fixture', version: '1' }, capabilities: { tools: {} } }
        : message.method === 'tools/list' ? { tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'through-proxy' }] }
      return { status_code: 200, header: { 'Content-Type': ['application/json'] }, body: JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) }
    }
    const pool = new McpClientPool()
    try {
      const failures = await pool.sync({ relay: { type: 'http', url: 'https://mcp-proxy.anthropic.com/v1/mcp/mcpsrv_test', fetch: manager.connectorFetch('claude-owned.json', 'mcpsrv_test') } })
      expect(failures).toEqual([])
      expect(pool.getConnectedSlugs()).toEqual(['relay'])
      const response = await pool.callTool('mcp__relay__lookup', {})
      expect(response.content).toContain('through-proxy')
      expect(messages).toContain('initialize')
      expect(messages).toContain('tools/call')
      await expect(manager.connectorFetch('claude-owned.json', 'mcpsrv_test')('https://untrusted.invalid/')).rejects.toThrow('destination')
    } finally { await pool.disconnectAll() }
  })
})
