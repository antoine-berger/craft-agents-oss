/**
 * Run in its own process: this exercises the real OAuth/SETUP handlers and
 * credential mapping with a temporary config and a JSON-backed credential store.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StoredCredential } from '@craft-agent/shared/credentials'
import type { LlmConnection } from '@craft-agent/shared/config'
import type { HandlerDeps } from '../handler-deps'
import type { RpcServer } from '@craft-agent/server-core/transport'

const previousConfigDir = process.env.CRAFT_CONFIG_DIR
const configDir = mkdtempSync(join(tmpdir(), 'craft-onboarding-scopes-'))
process.env.CRAFT_CONFIG_DIR = configDir

// Override only the storage boundary. The real convenience methods must retain
// scopes across their write/read mapping, without accessing host credentials.
const { getCredentialManager, credentialIdToAccount } = await import('@craft-agent/shared/credentials')
const manager = getCredentialManager()
const originalGet = manager.get
const originalSet = manager.set
const originalDelete = manager.delete
const records = new Map<string, string>()
manager.get = async id => {
  const record = records.get(credentialIdToAccount(id))
  return record ? JSON.parse(record) as StoredCredential : null
}
manager.set = async (id, credential) => {
  records.set(credentialIdToAccount(id), JSON.stringify(credential))
}
manager.delete = async id => records.delete(credentialIdToAccount(id))

const { saveConfig, migrateLegacyCredentials } = await import('@craft-agent/shared/config/storage')
const { clearOAuthState } = await import('@craft-agent/shared/auth')
const { RPC_CHANNELS } = await import('@craft-agent/shared/protocol')
const { registerOnboardingHandlers } = await import('./onboarding')
const { registerLlmConnectionsHandlers } = await import('./llm-connections')
const originalFetch = globalThis.fetch
const reinitializedConnections: string[] = []
let tokenResponse: {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
}

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
const server = {
  handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
    handlers.set(channel, handler)
  },
} as unknown as RpcServer
const deps = {
  platform: { logger: { info() {}, warn() {}, error() {} } },
  sessionManager: {
    reinitializeAuth: async (slug: string) => { reinitializedConnections.push(slug) },
  },
} as unknown as HandlerDeps
registerOnboardingHandlers(server, deps)
registerLlmConnectionsHandlers(server, deps)

type HandlerResult = { success: boolean; error?: string; token?: string }

async function invoke(
  channel: string, ...args: unknown[]
): Promise<HandlerResult> {
  return await handlers.get(channel)!({}, ...args) as HandlerResult
}

function connection(slug: string): LlmConnection {
  return {
    slug, name: slug, providerType: 'anthropic', authType: 'oauth', createdAt: 0,
    models: ['claude-sonnet-4-6'], modelSelectionMode: 'userDefined3Tier',
  }
}

async function exchangeAndSetup(slug: string): Promise<void> {
  expect((await invoke(RPC_CHANNELS.onboarding.START_CLAUDE_OAUTH)).success).toBe(true)
  const exchange = await invoke(RPC_CHANNELS.onboarding.EXCHANGE_CLAUDE_CODE, 'test-code', slug)
  expect(exchange.success).toBe(true)
  expect(exchange.token).toBe(tokenResponse.access_token)
  expect(await invoke(RPC_CHANNELS.settings.SETUP_LLM_CONNECTION, {
    slug, credential: exchange.token,
  })).toEqual({ success: true })
}

beforeEach(() => {
  records.clear()
  clearOAuthState()
  reinitializedConnections.length = 0
  saveConfig({
    llmConnections: [connection('account-a'), connection('account-b')],
    defaultLlmConnection: 'account-a',
    workspaces: [], activeWorkspaceId: null, activeSessionId: null,
  })
  tokenResponse = {
    access_token: 'a-access', refresh_token: 'a-refresh', expires_in: 3600,
    scope: 'user:inference user:mcp_servers',
  }
  globalThis.fetch = Object.assign(async () => Response.json(tokenResponse), {
    preconnect: originalFetch.preconnect,
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  clearOAuthState()
})

afterAll(() => {
  manager.get = originalGet
  manager.set = originalSet
  manager.delete = originalDelete
  if (previousConfigDir === undefined) delete process.env.CRAFT_CONFIG_DIR
  else process.env.CRAFT_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe('Claude OAuth onboarding granted scopes', () => {
  it('retains the full exchange grant through SETUP and keeps account grants separate', async () => {
    const beforeExchange = Date.now()
    await exchangeAndSetup('account-a')
    const first = await manager.getLlmOAuth('account-a')
    expect(first).toMatchObject({
      accessToken: 'a-access', refreshToken: 'a-refresh',
      scopes: ['user:inference', 'user:mcp_servers'],
    })
    expect(first?.expiresAt).toBeGreaterThanOrEqual(beforeExchange + 3600000)
    expect(await manager.getClaudeOAuthCredentials()).toMatchObject({
      accessToken: first!.accessToken, refreshToken: first!.refreshToken,
      expiresAt: first!.expiresAt, scopes: first!.scopes, source: 'native',
    })

    tokenResponse = {
      access_token: 'b-access', refresh_token: 'b-refresh', expires_in: 3600,
      scope: 'user:inference',
    }
    await exchangeAndSetup('account-b')
    expect(await manager.getLlmOAuth('account-a')).toEqual(first)
    expect(await manager.getLlmOAuth('account-b')).toMatchObject({
      accessToken: 'b-access', refreshToken: 'b-refresh', scopes: ['user:inference'],
    })
    expect((await manager.getClaudeOAuthCredentials())?.scopes).toEqual(['user:inference'])
    expect(reinitializedConnections).toEqual(['account-a', 'account-b'])
  })

  it('does not give a replacement access token the previous account grant or refresh token', async () => {
    await exchangeAndSetup('account-a')

    expect(await invoke(RPC_CHANNELS.settings.SETUP_LLM_CONNECTION, {
      slug: 'account-a', credential: 'replacement-token-without-grant',
    })).toEqual({ success: true })

    const replaced = await manager.getLlmOAuth('account-a')
    expect(replaced?.accessToken).toBe('replacement-token-without-grant')
    expect(replaced?.scopes).toBeUndefined()
    expect(replaced?.refreshToken).toBeUndefined()
    expect(replaced?.expiresAt).toBeUndefined()
  })

  it('leaves scopes unknown after reauthentication when the provider omits them', async () => {
    await exchangeAndSetup('account-a')
    tokenResponse = { access_token: 'a-new-access', refresh_token: 'a-new-refresh', expires_in: 3600 }

    await exchangeAndSetup('account-a')

    const stored = await manager.getLlmOAuth('account-a')
    expect(stored?.accessToken).toBe('a-new-access')
    expect(stored?.refreshToken).toBe('a-new-refresh')
    expect(stored?.scopes).toBeUndefined()
    expect((await manager.getClaudeOAuthCredentials())?.scopes).toBeUndefined()
  })

  it.each([{ scopes: undefined }, { scopes: ['user:inference', 'user:mcp_servers'] }])(
    'migrates legacy credentials without inventing or losing granted scopes (%j)', async ({ scopes: granted }) => {
      const scopes = granted ? [...granted] : undefined
      await manager.setClaudeOAuthCredentials({
        accessToken: 'legacy-access', refreshToken: 'legacy-refresh', expiresAt: 12345,
        scopes, source: 'native',
      })

      await migrateLegacyCredentials()

      expect(await manager.getLlmOAuth('claude-max')).toMatchObject({
        accessToken: 'legacy-access', refreshToken: 'legacy-refresh', expiresAt: 12345,
      })
      expect((await manager.getLlmOAuth('claude-max'))?.scopes).toEqual(scopes)
      expect(await manager.getClaudeOAuthCredentials()).toBeNull()
    },
  )
})
