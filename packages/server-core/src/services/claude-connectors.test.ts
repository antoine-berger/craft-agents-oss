import { describe, expect, it } from 'bun:test'
import { connectorSources } from './claude-connectors'
import type { LlmConnection } from '@craft-agent/shared/config/llm-connections'
import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk'

describe('native Claude connector display', () => {
  const connection = { slug: 'claude-main', name: 'Claude Max' } as LlmConnection
  const workspace = { id: 'cloud', rootPath: '/data/cloud' }
  const servers: McpServerStatus[] = [
    { name: 'claude.ai Read AI', status: 'connected', source: 'claudeai', tools: [{ name: 'search', description: 'Search meetings' }] },
    { name: 'claude.ai Notion', status: 'needs-auth', source: 'claudeai' },
  ]
  it('displays connected and unauthenticated servers without creating executable Craft sources', () => {
    const sources = connectorSources(servers, connection, workspace)
    expect(sources[0]?.config.name).toBe('Read AI')
    expect(sources[0]?.config.connectionStatus).toBe('connected')
    expect(sources[1]?.config.connectionStatus).toBe('needs_auth')
    expect(sources[0]?.claudeAccount?.tools).toEqual([{ name: 'search', description: 'Search meetings' }])
    expect(sources[0]?.config.mcp).toBeUndefined()
    expect(sources[0]?.folderPath).toBe('')
  })
  it('isolates identical connector names from different accounts and keeps stable identities', () => {
    const first = connectorSources(servers, connection, workspace)
    const repeat = connectorSources(servers, connection, workspace)
    const other = connectorSources(servers, { ...connection, slug: 'claude-other' }, workspace)
    expect(first[0]?.config.slug).toBe(repeat[0]?.config.slug)
    expect(first[0]?.config.slug).not.toBe(other[0]?.config.slug)
    expect(JSON.stringify(first)).not.toContain('accessToken')
  })
})
