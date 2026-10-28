import { createHash } from 'node:crypto'
import { loadStoredConfig } from '@craft-agent/shared/config'
import { CraftMcpClient } from '@craft-agent/shared/mcp/client'
import type { LoadedSource } from '@craft-agent/shared/sources'
import { getCliProxyManager } from './manager'

interface Connector { id: string; display_name: string; url: string; additional_install?: boolean; eligible?: boolean }
interface Discovered { expires: number; server: Connector; status: 'connected' | 'needs_auth' | 'failed'; tools: Array<{ name: string; description?: string }> }
let cache: { accountId: string; expires: number; entries: Discovered[] } | undefined
let pending: { accountId: string; result: Promise<Discovered[]> } | undefined

export const usesCliProxyForAll = (): boolean => loadStoredConfig()?.cliProxyRoutingAll === true
export function clearProxyConnectorCache(): void { cache = undefined }

async function discover(accountId: string, previous: Discovered[] = []): Promise<Discovered[]> {
  const manager = getCliProxyManager()
  const response = await manager.relayConnector(accountId, undefined, 'GET')
  if (response.status_code !== 200) throw new Error(`CLIProxyAPI connector discovery failed (${response.status_code})`)
  const data = JSON.parse(response.body)
  if (!Array.isArray(data.data) || data.next_page) throw new Error('Incomplete connector catalog')
  const seen = new Set<string>()
  const servers = (data.data as Connector[]).filter(server => {
    if (!/^mcpsrv_[A-Za-z0-9]+$/.test(server.id) || typeof server.display_name !== 'string') return false
    if (server.additional_install) return true
    if (seen.has(server.url)) return false
    seen.add(server.url)
    return true
  })
  return Promise.all(servers.map(async server => {
    if (server.eligible === false) return { server, status: 'failed' as const, tools: [], expires: Date.now() + 60_000 }
    const healthy = previous.find(entry => entry.server.id === server.id && entry.server.url === server.url
      && entry.status === 'connected' && entry.expires > Date.now())
    if (healthy) return { ...healthy, server }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12_000)
    const relay = manager.connectorFetch(accountId, server.id)
    const client = new CraftMcpClient({ transport: 'http', url: `https://mcp-proxy.anthropic.com/v1/mcp/${server.id}`,
      fetch: ((input, init) => relay(input, { ...init, signal: controller.signal })) as typeof fetch })
    try {
      await client.connect()
      const tools = await client.listTools()
      return { server, status: 'connected' as const, tools: tools.map(tool => ({ name: tool.name, description: tool.description })), expires: Date.now() + 60_000 }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const status = /401|403|auth|Unauthorized/i.test(message) ? 'needs_auth' as const : 'failed' as const
      // Log classification, not provider bodies/headers which may include credentials.
      console.warn('[CLIProxyAPI connectors] Discovery failed', { serverId: server.id, status,
        reason: /timeout|abort/i.test(message) ? 'timeout' : status === 'needs_auth' ? 'authentication' : 'connection',
        httpStatus: message.match(/\b[45]\d{2}\b/)?.[0] })
      return { server, status, tools: [], expires: Date.now() + 5_000 }
    } finally { clearTimeout(timeout); await client.close().catch(() => {}) }
  }))
}

export async function loadProxyConnectorSources(workspace: { id: string; rootPath: string }): Promise<LoadedSource[]> {
  if (!usesCliProxyForAll()) return []
  const account = await getCliProxyManager().connectorAccount()
  if (!cache || cache.accountId !== account.id || cache.expires < Date.now()) {
    const result = pending?.accountId === account.id ? pending.result : discover(account.id, cache?.accountId === account.id ? cache.entries : [])
    pending = { accountId: account.id, result }
    try {
      const entries = await result
      cache = { accountId: account.id, entries, expires: Math.min(Date.now() + 60_000, ...entries.map(entry => entry.expires)) }
    } catch (error) {
      console.warn('[CLIProxyAPI connectors] Catalog discovery failed', {
        httpStatus: (error instanceof Error ? error.message : '').match(/\b[45]\d{2}\b/)?.[0],
        reason: error instanceof SyntaxError ? 'invalid_catalog' : 'catalog_request' })
      throw error
    } finally { if (pending?.result === result) pending = undefined }
  }
  return cache.entries.map(({ server, status, tools }) => {
    const slug = `claudeai-${createHash('sha256').update(`${account.id}\0${server.id}`).digest('hex').slice(0, 20)}`
    return {
      config: { id: slug, slug, name: server.display_name, type: 'mcp', provider: 'claude.ai', enabled: true,
        icon: '🔌', connectionStatus: status, isAuthenticated: status === 'connected',
        tagline: `CLIProxyAPI · ${account.email ?? account.name}`, lastTestedAt: Date.now() },
      claudeAccount: { connectionSlug: 'cli-proxy-claude', connectionName: account.email ?? account.name, tools,
        proxy: { accountId: account.id, serverId: server.id } },
      guide: null, folderPath: '', workspaceRootPath: workspace.rootPath, workspaceId: workspace.id,
    }
  })
}
