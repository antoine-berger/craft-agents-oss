import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { query, type McpServerStatus } from '@anthropic-ai/claude-agent-sdk'
import { isClaudeAccountConnection, type LlmConnection } from '@craft-agent/shared/config/llm-connections'
import { getLlmConnections } from '@craft-agent/shared/config'
import { getValidClaudeOAuthToken } from '@craft-agent/shared/auth'
import { buildClaudeSubprocessEnv, getPathToClaudeCodeExecutable } from '@craft-agent/shared/agent/options'
import type { LoadedSource } from '@craft-agent/shared/sources'

const CACHE_MS = 60_000
const cache = new Map<string, { expires: number; servers: McpServerStatus[] }>()
const pending = new Map<string, Promise<McpServerStatus[]>>()
export const isClaudeConnectorSlug = (slug: string): boolean => slug.startsWith('claudeai-')

/** Control-plane discovery only: no user prompt, inference, or tool execution. */
export async function discoverClaudeConnectors(connectionSlug: string): Promise<McpServerStatus[]> {
  const auth = await getValidClaudeOAuthToken(connectionSlug)
  if (!auth.accessToken) throw new Error('Claude account requires authentication')
  const key = `${connectionSlug}:${createHash('sha256').update(auth.accessToken).digest('hex')}`
  const cached = cache.get(key)
  if (cached && cached.expires > Date.now()) return cached.servers
  const running = pending.get(key)
  if (running) return running
  const discovery = discover(auth.accessToken, auth.scopes ?? ['user:inference']).then(servers => {
    cache.set(key, { servers, expires: Date.now() + CACHE_MS })
    for (const [oldKey, entry] of cache) if (entry.expires < Date.now()) cache.delete(oldKey)
    return servers
  }).finally(() => pending.delete(key))
  pending.set(key, discovery)
  return discovery
}

async function discover(token: string, scopes: string[]): Promise<McpServerStatus[]> {
  let finishInput: (() => void) | undefined
  async function* input(): AsyncGenerator<never> {
    await new Promise<void>(resolve => { finishInput = resolve })
  }
  const abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort(), 8_000)
  const env = buildClaudeSubprocessEnv({ CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CODE_OAUTH_SCOPES: scopes.join(' ') })
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.ANTHROPIC_BASE_URL
  const session = query({ prompt: input(), options: {
    env, pathToClaudeCodeExecutable: getPathToClaudeCodeExecutable(),
    cwd: tmpdir(), settingSources: [], persistSession: false, tools: [], mcpServers: {},
    permissionMode: 'default', abortController,
    canUseTool: async () => ({ behavior: 'deny', message: 'Connector discovery never executes tools' }),
  } })
  try {
    let servers: McpServerStatus[] = []
    for (let attempt = 0; attempt < 7; attempt++) {
      servers = (await session.mcpServerStatus()).filter(server => server.source === 'claudeai' || server.scope === 'claudeai')
      if (servers.length && !servers.some(server => server.status === 'pending')) break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    return servers
  } finally {
    clearTimeout(timer)
    finishInput?.()
    session.close()
  }
}

export function connectorSources(servers: McpServerStatus[], connection: LlmConnection, workspace: { id: string; rootPath: string }): LoadedSource[] {
  return servers.map(server => {
    const slug = `claudeai-${createHash('sha256').update(`${connection.slug}\0${server.name}`).digest('hex').slice(0, 20)}`
    const status = server.status === 'connected' ? 'connected' : server.status === 'needs-auth' ? 'needs_auth' : server.status === 'pending' ? 'untested' : 'failed'
    return {
      config: { id: slug, slug, name: server.name.replace(/^claude\.ai\s+/i, ''), type: 'mcp', provider: 'claude.ai',
        enabled: true, icon: '🔌', connectionStatus: status, isAuthenticated: server.status === 'connected',
        tagline: `claude.ai · ${connection.name}`, lastTestedAt: Date.now() },
      claudeAccount: { connectionSlug: connection.slug, connectionName: connection.name,
        tools: server.tools?.map(tool => ({ name: tool.name, description: tool.description })) ?? [] },
      guide: null, folderPath: '', workspaceRootPath: workspace.rootPath, workspaceId: workspace.id,
    }
  })
}

export async function loadClaudeConnectorSources(workspace: { id: string; rootPath: string }): Promise<LoadedSource[]> {
  const accounts = getLlmConnections().filter(isClaudeAccountConnection)
  const results = await Promise.allSettled(accounts.map(async connection => {
    const servers = await discoverClaudeConnectors(connection.slug)
    return connectorSources(servers, connection, workspace)
  }))
  if (results.length && results.every(result => result.status === 'rejected')) throw new Error('Claude connector discovery failed for every account')
  return results.flatMap(result => result.status === 'fulfilled' ? result.value : [])
}
