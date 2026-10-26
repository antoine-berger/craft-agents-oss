/** Real source loading/building with isolated config; no model or source network calls. */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LoadedSource } from '@craft-agent/shared/sources'
import type { LlmConnection } from '@craft-agent/shared/config'

const previousConfigDir = process.env.CRAFT_CONFIG_DIR
const configDir = mkdtempSync(join(tmpdir(), 'craft-claude-ai-sources-'))
process.env.CRAFT_CONFIG_DIR = configDir

const { saveConfig } = await import('@craft-agent/shared/config/storage')
const { saveWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
const { loadAllSources, getSourceCredentialManager } = await import('@craft-agent/shared/sources')
const { sessionPersistenceQueue } = await import('@craft-agent/shared/sessions')
const { setupI18n } = await import('@craft-agent/shared/i18n')
const { createManagedSession, SessionManager } = await import('./SessionManager')
setupI18n()

type ManagedSession = ReturnType<typeof createManagedSession>
type Harness = {
  sessions: Map<string, ManagedSession>
  filterSessionSources(session: ManagedSession, sources: LoadedSource[]): LoadedSource[]
  reloadSessionSources(session: ManagedSession): Promise<void>
  getOrCreateAgent(session: ManagedSession): Promise<NonNullable<ManagedSession['agent']>>
  sendEvent: ReturnType<typeof mock>
}

const credentialManager = getSourceCredentialManager()
const originalGetToken = credentialManager.getToken
const originalGetApiCredential = credentialManager.getApiCredential
const credentialReads: string[] = []
credentialManager.getToken = async source => {
  credentialReads.push(source.config.slug)
  return null
}
credentialManager.getApiCredential = async source => {
  credentialReads.push(source.config.slug)
  return null
}

const connections: LlmConnection[] = [
  { slug: 'claude-account', name: 'Claude', providerType: 'anthropic', authType: 'oauth', createdAt: 1 },
  { slug: 'anthropic-api', name: 'API', providerType: 'anthropic', authType: 'api_key', createdAt: 1 },
  { slug: 'other-account', name: 'Other', providerType: 'pi', authType: 'oauth', createdAt: 1 },
]

let manager: InstanceType<typeof SessionManager>
let internal: Harness
let workspace: ManagedSession['workspace']

function writeSource(slug: string, details: Record<string, unknown>) {
  const folder = join(workspace.rootPath, 'sources', slug)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'config.json'), JSON.stringify({
    id: slug, slug, name: slug, enabled: true, provider: 'custom',
    createdAt: 1, updatedAt: 1, ...details,
  }))
  writeFileSync(join(folder, 'guide.md'), `# ${slug}\n`)
}

function createSession(connectionSlug?: string) {
  const managed = createManagedSession({
    id: randomUUID(), name: 'source policy', llmConnection: connectionSlug,
    enabledSourceSlugs: ['craft-mcp', 'rest-api', 'files'],
  }, workspace, { messagesLoaded: true })
  internal.sessions.set(managed.id, managed)
  return managed
}

function attachAgent(managed: ManagedSession) {
  const agent = {
    setAllSources: mock((_sources: LoadedSource[]) => {}),
    setSourceServers: mock(async (_mcp: unknown, _api: unknown, _slugs: string[]) => {}),
    getSummarizeCallback: () => undefined,
  }
  managed.agent = agent as unknown as NonNullable<ManagedSession['agent']>
  return agent
}

beforeEach(() => {
  workspace = { id: randomUUID(), slug: 'test', name: 'Test', rootPath: join(configDir, randomUUID()), createdAt: 1 }
  mkdirSync(workspace.rootPath)
  saveConfig({
    llmConnections: connections, defaultLlmConnection: 'claude-account',
    workspaces: [workspace], activeWorkspaceId: workspace.id, activeSessionId: null,
  })
  saveWorkspaceConfig(workspace.rootPath, {
    id: workspace.id, name: 'Test', slug: 'test', createdAt: 1, updatedAt: 1,
    defaults: { defaultLlmConnection: 'anthropic-api' },
  })
  writeSource('craft-mcp', { type: 'mcp', mcp: { url: 'https://mcp.example.invalid', authType: 'none' } })
  writeSource('rest-api', { type: 'api', api: { baseUrl: 'https://api.example.invalid', authType: 'none' } })
  writeSource('files', { type: 'local', local: { path: workspace.rootPath } })
  credentialReads.length = 0
  manager = new SessionManager()
  internal = manager as unknown as Harness
  internal.sendEvent = mock(() => {})
})

afterEach(async () => {
  for (const session of internal.sessions.values()) {
    await sessionPersistenceQueue.flush(session.id)
    sessionPersistenceQueue.cancel(session.id)
  }
  rmSync(workspace.rootPath, { recursive: true, force: true })
})

afterAll(() => {
  credentialManager.getToken = originalGetToken
  credentialManager.getApiCredential = originalGetApiCredential
  if (previousConfigDir === undefined) delete process.env.CRAFT_CONFIG_DIR
  else process.env.CRAFT_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe('claude.ai owns MCP connections for Claude account sessions', () => {
  it('resolves the effective session/workspace/global connection before filtering', () => {
    const sources = loadAllSources(workspace.rootPath)
    const slugs = (session: ManagedSession) => internal.filterSessionSources(session, sources).map(s => s.config.slug).sort()
    expect(slugs(createSession('claude-account'))).toEqual(['files', 'rest-api'])
    expect(slugs(createSession('anthropic-api'))).toEqual(['craft-mcp', 'files', 'rest-api'])
    expect(slugs(createSession('other-account'))).toEqual(['craft-mcp', 'files', 'rest-api'])
    expect(slugs(createSession())).toEqual(['craft-mcp', 'files', 'rest-api'])
    saveWorkspaceConfig(workspace.rootPath, {
      id: workspace.id, name: 'Test', slug: 'test', createdAt: 1, updatedAt: 1,
    })
    expect(slugs(createSession())).toEqual(['files', 'rest-api'])
  })

  it('removes Craft MCP selections before building or reading credentials, retaining API proxies and files', async () => {
    const managed = createSession('claude-account')
    const agent = attachAgent(managed)
    const sourcePath = join(workspace.rootPath, 'sources', 'craft-mcp', 'config.json')
    const before = readFileSync(sourcePath, 'utf8')
    await manager.setSessionSources(managed.id, ['craft-mcp', 'rest-api', 'files'])
    expect(manager.getSessionSources(managed.id)).toEqual(['rest-api', 'files'])
    expect(credentialReads).not.toContain('craft-mcp')
    expect(credentialReads).toContain('rest-api')
    const [mcp, api, intended] = agent.setSourceServers.mock.calls[0]!
    expect(Object.keys(mcp as object)).toEqual([])
    expect(Object.keys(api as object)).toEqual(['rest-api'])
    expect(intended).toEqual(['rest-api', 'files'])
    expect(agent.setAllSources.mock.calls[0]![0].map(s => s.config.type)).not.toContain('mcp')
    expect(readFileSync(sourcePath, 'utf8')).toBe(before)
    expect(internal.sendEvent).toHaveBeenCalledWith({
      type: 'sources_changed', sessionId: managed.id, enabledSourceSlugs: ['rest-api', 'files'],
    }, workspace.id)
  })

  it('keeps the policy on a source-watcher reload even with stale persisted MCP selections', async () => {
    const managed = createSession('claude-account')
    const agent = attachAgent(managed)
    await internal.reloadSessionSources(managed)
    expect(credentialReads).not.toContain('craft-mcp')
    expect(Object.keys(agent.setSourceServers.mock.calls[0]![0] as object)).toEqual([])
    expect(Object.keys(agent.setSourceServers.mock.calls[0]![1] as object)).toEqual(['rest-api'])
  })

  it('filters sources before the pre-send OAuth refresh, including a cold session', async () => {
    const managed = createSession('claude-account')
    const refreshInputs: string[][] = []
    managed.tokenRefreshManager!.getSourcesNeedingRefresh = async sources => {
      refreshInputs.push(sources.map(s => s.config.slug))
      return []
    }
    internal.getOrCreateAgent = async () => { throw new Error('Stop before constructing a model backend') }
    await manager.sendMessage(managed.id, 'hello').catch(() => {})
    expect(refreshInputs).toEqual([['rest-api', 'files']])
    expect(managed.isProcessing).toBe(false)
  })

  it('still builds Craft MCP sources for API-key connections', async () => {
    const managed = createSession('anthropic-api')
    const agent = attachAgent(managed)
    await manager.setSessionSources(managed.id, ['craft-mcp'])
    expect(manager.getSessionSources(managed.id)).toEqual(['craft-mcp'])
    expect(credentialReads).toContain('craft-mcp')
    expect(Object.keys(agent.setSourceServers.mock.calls[0]![0] as object)).toEqual(['craft-mcp'])
  })
})
