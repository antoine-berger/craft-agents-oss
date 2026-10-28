// Run alone: module mocks must not replace the real manager in other suites.
import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
let now = 1_000_000;let failing = new Set<string>();let selected = 'account-a';let catalogFails = false
const connects: Record<string, number> = {}
const catalog = [
  { id: 'mcpsrv_linear', display_name: 'Linear', url: 'https://linear.invalid' },
  { id: 'mcpsrv_slack', display_name: 'Slack', url: 'https://slack.invalid' },
]
const relay = mock(async () => ({ status_code: catalogFails ? 503 : 200, body: JSON.stringify({ data: catalog }) }))
mock.module('@craft-agent/shared/config', () => ({ loadStoredConfig: () => ({ cliProxyRoutingAll: true }) }))
mock.module('./manager', () => ({ getCliProxyManager: () => ({
  connectorAccount: async () => ({ id: selected, name: 'test' }), relayConnector: relay, connectorFetch: () => fetch,
}) }))
mock.module('@craft-agent/shared/mcp/client', () => ({ CraftMcpClient: class {
  id: string
  constructor(options: any) { this.id = options.url.split('/').at(-1) }
  async connect() { connects[this.id] = (connects[this.id] ?? 0) + 1;if (failing.has(this.id)) throw Error('HTTP 503 Bearer do-not-log-secret') }
  async listTools() { return [{ name: 'lookup' }] }
  async close() {}
} }))
const { clearProxyConnectorCache, loadProxyConnectorSources } = await import('./connectors')
const clock = spyOn(Date, 'now').mockImplementation(() => now)
const warnings = spyOn(console, 'warn').mockImplementation(() => {})
afterAll(() => { clock.mockRestore();warnings.mockRestore() })
beforeEach(() => { clearProxyConnectorCache();now = 1_000_000;failing = new Set();selected = 'account-a';catalogFails = false;for (const k of Object.keys(connects)) delete connects[k];relay.mockClear();warnings.mockClear() })
const workspace = { id: 'test', rootPath: '/test' }

describe('connector discovery caching', () => {
  it('retries failures after 5s while retaining healthy discoveries for 60s', async () => {
    failing.add('mcpsrv_slack')
    const first = await loadProxyConnectorSources(workspace)
    expect(first.map(x => x.config.connectionStatus)).toEqual(['connected', 'failed'])
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('do-not-log-secret')
    failing.clear();now += 4_999
    expect((await loadProxyConnectorSources(workspace))[1]!.config.isAuthenticated).toBe(false)
    expect(relay).toHaveBeenCalledTimes(1)
    now += 2
    expect((await loadProxyConnectorSources(workspace))[1]!.config.isAuthenticated).toBe(true)
    expect(connects.mcpsrv_linear).toBe(1)
    expect(connects.mcpsrv_slack).toBe(2)
    now += 55_001;await loadProxyConnectorSources(workspace)
    expect(connects.mcpsrv_linear).toBe(2)
    expect(connects.mcpsrv_slack).toBe(2)
  })

  it('shares concurrent discovery and caches healthy results for a minute', async () => {
    const [a,b] = await Promise.all([loadProxyConnectorSources(workspace),loadProxyConnectorSources(workspace)])
    expect(a.map(x=>x.config.slug)).toEqual(b.map(x=>x.config.slug))
    expect(relay).toHaveBeenCalledTimes(1)
    now += 59_999;await loadProxyConnectorSources(workspace)
    expect(connects.mcpsrv_linear).toBe(1)
  })

  it('does not cache a failed catalog request', async () => {
    catalogFails = true;await expect(loadProxyConnectorSources(workspace)).rejects.toThrow('503')
    catalogFails = false;expect(await loadProxyConnectorSources(workspace)).toHaveLength(2)
    expect(relay).toHaveBeenCalledTimes(2)
  })

  it('does not reuse another account cache', async () => {
    const a = await loadProxyConnectorSources(workspace);selected = 'account-b';const b = await loadProxyConnectorSources(workspace)
    expect(a[0]!.config.slug).not.toBe(b[0]!.config.slug)
    expect(connects.mcpsrv_linear).toBe(2)
  })
})
