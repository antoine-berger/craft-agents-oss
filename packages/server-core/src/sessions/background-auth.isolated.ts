import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CredentialId, StoredCredential } from '@craft-agent/shared/credentials'
import type { LlmConnection } from '@craft-agent/shared/config'
import type { AgentBackend, PostInitResult } from '@craft-agent/shared/agent/backend'

// Run separately: real Claude postInit resolves credentials/config and changes process auth env.
// All credentials below are fixtures; no backend query or external service is started.
const envKeys = [
  'CRAFT_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES', 'CLAUDE_CODE_USE_BEDROCK',
  'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const
const originalEnv = new Map(envKeys.map(key => [key, process.env[key]]))
const configDir = mkdtempSync(join(tmpdir(), 'craft-background-auth-'))
process.env.CRAFT_CONFIG_DIR = configDir

const { getCredentialManager } = await import('@craft-agent/shared/credentials')
const credentialManager = getCredentialManager()
const originalGet = credentialManager.get
let readCredential: (id: CredentialId) => Promise<StoredCredential | null>
credentialManager.get = id => readCredential(id)

const { saveConfig } = await import('@craft-agent/shared/config/storage')
const { _resetRefreshMutex } = await import('@craft-agent/shared/auth/state')
const { ClaudeAgent } = await import('@craft-agent/shared/agent/claude-agent')
const { buildClaudeSubprocessEnv } = await import('@craft-agent/shared/agent/options')
const backend = await import('@craft-agent/shared/agent/backend')
const { SessionManager, createManagedSession, setSessionPlatform } = await import('./SessionManager')

setSessionPlatform({
  appRootPath: configDir, resourcesPath: join(configDir, 'resources'), isPackaged: false,
  appVersion: 'test', isDebugMode: false,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  imageProcessor: {
    async getMetadata() { return null },
    async process() { throw new Error('Unexpected image processing') },
  },
})

const spies: Array<{ mockRestore(): void }> = []
const connection = (slug: string): LlmConnection => ({
  slug, name: slug, providerType: 'anthropic', authType: 'oauth',
  defaultModel: 'claude-sonnet-4-6', createdAt: 0,
})

beforeEach(() => {
  _resetRefreshMutex()
  readCredential = async () => null
  saveConfig({
    llmConnections: [connection('account-a'), connection('account-b')], defaultLlmConnection: 'account-a',
    workspaces: [], activeWorkspaceId: null, activeSessionId: null,
  })
})

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  _resetRefreshMutex()
})

afterAll(() => {
  credentialManager.get = originalGet
  for (const key of envKeys) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(configDir, { recursive: true, force: true })
})

function setup() {
  const manager = new SessionManager()
  manager.setEventSink(() => {})
  const workspace = { id: 'ws-background', slug: 'ws-background', name: 'Test', rootPath: configDir, createdAt: 0 }
  const session = (slug: string) => {
    const managed = createManagedSession({ id: `summary-${slug}`, llmConnection: slug }, workspace, { messagesLoaded: true })
    managed.messages = [
      { id: 'user', role: 'user', content: 'Keep the chat in its isolated worktree.', timestamp: 1 },
      { id: 'assistant', role: 'assistant', content: 'The change is ready for testing.', timestamp: 2 },
    ]
    return managed
  }
  return { manager, session }
}

type MiniAgent = {
  config: { connectionSlug: string; miniModel?: string; envOverrides?: Record<string, string> }
  postInit(): Promise<PostInitResult>
  runMiniCompletion: ReturnType<typeof mock<(prompt: string) => Promise<string | null>>>
  destroy: ReturnType<typeof mock<() => void>>
}

function installBackendStub(afterAuth: (slug: string) => Promise<void> = async () => {}) {
  const agents = new Map<string, MiniAgent>()
  const requests: Array<{ slug: string; token?: string; scopes?: string; prompt: string }> = []
  const factory = spyOn(backend, 'createBackendFromResolvedContext').mockImplementation(options => {
    const slug = options.context.connection!.slug
    const agent: MiniAgent = {
      config: {
        connectionSlug: slug, miniModel: options.coreConfig.miniModel,
        envOverrides: options.coreConfig.envOverrides,
      },
      async postInit() {
        const result = await ClaudeAgent.prototype.postInit.call(this as unknown as InstanceType<typeof ClaudeAgent>)
        await afterAuth(slug)
        return result
      },
      runMiniCompletion: mock(async (prompt: string) => {
        const env = buildClaudeSubprocessEnv(agent.config.envOverrides)
        requests.push({ slug, token: env.CLAUDE_CODE_OAUTH_TOKEN, scopes: env.CLAUDE_CODE_OAUTH_SCOPES, prompt })
        return `Summary from ${slug}`
      }),
      destroy: mock(() => {}),
    }
    agents.set(slug, agent)
    return agent as unknown as AgentBackend
  })
  spies.push(factory)
  return { agents, requests }
}

describe('background handoff authentication', () => {
  it('pins each summary to its session account even when another account initializes before its model call', async () => {
    const { manager, session } = setup()
    const aAuthenticated = Promise.withResolvers<void>()
    const continueA = Promise.withResolvers<void>()
    const { agents, requests } = installBackendStub(async slug => {
      if (slug === 'account-a') {
        aAuthenticated.resolve()
        await continueA.promise
      }
    })
    readCredential = async id => id.type === 'llm_oauth' ? {
      value: `${id.connectionSlug}-token`, expiresAt: Date.now() + 3600000,
      scopes: id.connectionSlug === 'account-a' ? ['user:inference'] : ['user:inference', 'user:mcp_servers'],
    } : null

    const aSummary = (manager as any).generateSessionHandoffSummary(session('account-a'))
    await aAuthenticated.promise
    expect(requests).toHaveLength(0)
    await expect((manager as any).generateSessionHandoffSummary(session('account-b'))).resolves.toBe('Summary from account-b')
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('account-b-token')
    continueA.resolve()
    await expect(aSummary).resolves.toBe('Summary from account-a')

    expect(requests.map(({ slug, token, scopes }) => ({ slug, token, scopes }))).toEqual([
      { slug: 'account-b', token: 'account-b-token', scopes: 'user:inference user:mcp_servers' },
      { slug: 'account-a', token: 'account-a-token', scopes: 'user:inference' },
    ])
    expect(requests[0]!.prompt).toContain('Keep the chat in its isolated worktree.')
    for (const agent of agents.values()) expect(agent.destroy).toHaveBeenCalledTimes(1)
  })

  it('fails softly and makes no model call when the selected account has no credentials', async () => {
    const { manager, session } = setup()
    const { agents, requests } = installBackendStub()
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'another-account-token'
    process.env.CLAUDE_CODE_OAUTH_SCOPES = 'user:inference user:mcp_servers'

    await expect((manager as any).generateSessionHandoffSummary(session('account-a'))).resolves.toBeNull()
    expect(requests).toHaveLength(0)
    expect(agents.get('account-a')!.destroy).toHaveBeenCalledTimes(1)
  })

  it('destroys the temporary backend when credential lookup throws', async () => {
    const { manager, session } = setup()
    const { agents, requests } = installBackendStub()
    readCredential = async () => { throw new Error('Credential store unavailable') }

    await expect((manager as any).generateSessionHandoffSummary(session('account-a'))).resolves.toBeNull()
    expect(requests).toHaveLength(0)
    expect(agents.get('account-a')!.destroy).toHaveBeenCalledTimes(1)
  })
})
