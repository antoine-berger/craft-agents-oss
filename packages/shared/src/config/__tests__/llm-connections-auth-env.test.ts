import { afterEach, describe, expect, it } from 'bun:test'
import type { LlmConnection } from '../storage.ts'
import type { CredentialManager } from '../../credentials/manager.ts'
import {
  clearClaudeBedrockRoutingEnvVars,
  resolveAuthEnvVars,
  resetManagedAnthropicAuthEnvVars,
} from '../llm-connections.ts'

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
)

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key)
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

afterEach(() => {
  restoreEnv()
})

describe('Claude OAuth account scopes in auth env', () => {
  const manager = {} as CredentialManager
  const connection = (slug: string): LlmConnection => ({
    slug, name: slug, providerType: 'anthropic', authType: 'oauth', createdAt: 0,
  })

  it('forwards the token and actual grant returned for the selected connection', async () => {
    const selectedSlugs: string[] = []
    const result = await resolveAuthEnvVars(connection('selected'), 'selected', manager, async slug => {
      selectedSlugs.push(slug)
      return { accessToken: 'selected-access', scopes: ['user:profile', 'user:inference', 'user:mcp_servers'] }
    })

    expect(selectedSlugs).toEqual(['selected'])
    expect(result).toEqual({
      success: true,
      envVars: {
        CLAUDE_CODE_OAUTH_TOKEN: 'selected-access',
        CLAUDE_CODE_OAUTH_SCOPES: 'user:profile user:inference user:mcp_servers',
      },
    })
  })

  it.each([{ scopes: undefined }, { scopes: [] as string[] }])(
    'uses inference-only for an unknown or empty grant despite global connector scopes (%j)', async ({ scopes }) => {
      process.env.CLAUDE_CODE_OAUTH_SCOPES = 'user:inference user:mcp_servers'

      const result = await resolveAuthEnvVars(connection('legacy'), 'legacy', manager, async () => ({
        accessToken: 'legacy-access', scopes,
      }))

      expect(result.success).toBe(true)
      expect(result.envVars.CLAUDE_CODE_OAUTH_SCOPES).toBe('user:inference')
    },
  )

  it('keeps distinct account grants separate when resolved together', async () => {
    const grants = {
      a: { accessToken: 'a-access', scopes: ['user:inference', 'user:mcp_servers'] },
      b: { accessToken: 'b-access', scopes: ['user:inference'] },
    }
    const resolve = async (slug: string) => grants[slug as keyof typeof grants]
    const [a, b] = await Promise.all([
      resolveAuthEnvVars(connection('a'), 'a', manager, resolve),
      resolveAuthEnvVars(connection('b'), 'b', manager, resolve),
    ])

    expect(a.envVars).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'a-access', CLAUDE_CODE_OAUTH_SCOPES: 'user:inference user:mcp_servers',
    })
    expect(b.envVars).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'b-access', CLAUDE_CODE_OAUTH_SCOPES: 'user:inference',
    })
  })

  it('does not recover a failed account from globally available token or scopes', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'different-account-access'
    process.env.CLAUDE_CODE_OAUTH_SCOPES = 'user:inference user:mcp_servers'

    const result = await resolveAuthEnvVars(connection('missing'), 'missing', manager, async () => ({
      accessToken: null,
    }))

    expect(result.success).toBe(false)
    expect(result.envVars.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(result.envVars.CLAUDE_CODE_OAUTH_SCOPES).toBeUndefined()
  })

  it('resets scope metadata together with the token before switching connection auth', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'previous-account-access'
    process.env.CLAUDE_CODE_OAUTH_SCOPES = 'user:inference user:mcp_servers'

    resetManagedAnthropicAuthEnvVars()

    expect(originalEnv.get('CLAUDE_CODE_OAUTH_TOKEN')).toBe(process.env.CLAUDE_CODE_OAUTH_TOKEN)
    expect(originalEnv.get('CLAUDE_CODE_OAUTH_SCOPES')).toBe(process.env.CLAUDE_CODE_OAUTH_SCOPES)
  })
})

function createBedrockConnection(
  overrides: Partial<LlmConnection> = {},
): LlmConnection {
  return {
    slug: 'bedrock-test',
    name: 'Bedrock Test',
    providerType: 'bedrock',
    authType: 'bearer_token',
    awsRegion: 'us-east-1',
    createdAt: Date.now(),
    ...overrides,
  } as LlmConnection
}

describe('Bedrock auth env handling', () => {
  it('resolveAuthEnvVars does not enable Claude Bedrock routing for bedrock connections', async () => {
    // Per packages/shared/CLAUDE.md: "Pi Bedrock uses its own AWS env path
    // instead." resolveAuthEnvVars is Anthropic-SDK-only and short-circuits
    // for non-Anthropic providers (including bedrock); the Pi backend wires
    // AWS credentials in its own postInit() path. The contract this test
    // protects is that none of the Claude-specific Bedrock routing env vars
    // — which would mis-route the Claude SDK subprocess at AWS — leak out.
    const connection = createBedrockConnection()
    const credentialManager = {
      getLlmApiKey: async () => 'bedrock-bearer-token',
      getLlmIamCredentials: async () => null,
    }

    const result = await resolveAuthEnvVars(
      connection,
      connection.slug,
      credentialManager as any,
      async () => ({}),
    )

    expect(result.success).toBe(true)
    expect(result.envVars.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(result.envVars.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined()
    expect(result.envVars.ANTHROPIC_BEDROCK_BASE_URL).toBeUndefined()
  })

  it('clearClaudeBedrockRoutingEnvVars removes only Claude-specific Bedrock routing vars', () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_BEARER_TOKEN_BEDROCK: 'token',
      ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.example.com',
      AWS_REGION: 'us-east-1',
    }

    clearClaudeBedrockRoutingEnvVars(env)

    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined()
    expect(env.ANTHROPIC_BEDROCK_BASE_URL).toBeUndefined()
    expect(env.AWS_REGION).toBe('us-east-1')
  })

  it('resetManagedAnthropicAuthEnvVars clears Bedrock routing vars from process env', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    process.env.AWS_BEARER_TOKEN_BEDROCK = 'token'
    process.env.ANTHROPIC_BEDROCK_BASE_URL = 'https://bedrock.example.com'
    process.env.AWS_REGION = 'us-east-1'

    resetManagedAnthropicAuthEnvVars()

    expect(process.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined()
    expect(process.env.ANTHROPIC_BEDROCK_BASE_URL).toBeUndefined()

    const originalRegion = originalEnv.get('AWS_REGION')
    if (originalRegion === undefined) {
      expect(process.env.AWS_REGION).toBeUndefined()
    } else {
      expect(process.env.AWS_REGION).toBe(originalRegion)
    }
  })
})
