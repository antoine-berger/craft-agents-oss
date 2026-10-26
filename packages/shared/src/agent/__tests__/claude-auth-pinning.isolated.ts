/**
 * Separate process: real postInit/auth resolution with temporary config and a
 * gated credential-store boundary; no agent constructor or SDK query is run.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CredentialId, StoredCredential } from '../../credentials/types.ts';
import type { LlmConnection } from '../../config/llm-connections.ts';

const ENV_KEYS = [
  'CRAFT_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES', 'CLAUDE_CODE_USE_BEDROCK',
  'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_BEDROCK_BASE_URL',
] as const;
const originalEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
const configDir = mkdtempSync(join(tmpdir(), 'craft-auth-pinning-'));
process.env.CRAFT_CONFIG_DIR = configDir;

const { getCredentialManager } = await import('../../credentials/index.ts');
const manager = getCredentialManager();
const originalGet = manager.get;
let readCredential: (id: CredentialId) => Promise<StoredCredential | null>;
manager.get = id => readCredential(id);

const { saveConfig } = await import('../../config/storage.ts');
const { _resetRefreshMutex } = await import('../../auth/state.ts');
const { ClaudeAgent } = await import('../claude-agent.ts');
const { buildClaudeSubprocessEnv } = await import('../options.ts');

interface AgentHarness {
  config: { connectionSlug: string; envOverrides?: Record<string, string> };
  postInit: InstanceType<typeof ClaudeAgent>['postInit'];
}

function agent(slug: string): AgentHarness {
  return Object.assign(Object.create(ClaudeAgent.prototype), {
    config: {
      connectionSlug: slug,
      envOverrides: {
        CRAFT_SESSION_TEST: slug,
        ANTHROPIC_API_KEY: 'stale-session-api-key',
        ANTHROPIC_AUTH_TOKEN: 'stale-session-auth-token',
        ANTHROPIC_BASE_URL: 'https://stale.example.invalid',
        CLAUDE_CODE_OAUTH_TOKEN: 'stale-session-oauth-token',
        CLAUDE_CODE_OAUTH_SCOPES: 'user:inference user:mcp_servers',
      },
    },
  }) as AgentHarness;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function connection(slug: string): LlmConnection {
  return { slug, name: slug, providerType: 'anthropic', authType: 'oauth', createdAt: 0 };
}

beforeEach(() => {
  _resetRefreshMutex();
  readCredential = async () => null;
  saveConfig({
    llmConnections: [connection('a'), connection('b')], defaultLlmConnection: 'a',
    workspaces: [], activeWorkspaceId: null, activeSessionId: null,
  });
});

afterEach(() => { _resetRefreshMutex(); });

afterAll(() => {
  manager.get = originalGet;
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(configDir, { recursive: true, force: true });
});

describe('ClaudeAgent auth pinning before lazy subprocess creation', () => {
  it('keeps each concurrent account token and grant after another postInit changes global auth', async () => {
    const aRead = deferred<StoredCredential | null>();
    const bRead = deferred<StoredCredential | null>();
    const bothStarted = deferred<void>();
    const reads: string[] = [];
    readCredential = async id => {
      if (id.type !== 'llm_oauth') return null;
      reads.push(id.connectionSlug!);
      if (reads.length === 2) bothStarted.resolve();
      return id.connectionSlug === 'a' ? aRead.promise : bRead.promise;
    };
    const a = agent('a');
    const b = agent('b');
    const aInit = a.postInit();
    const bInit = b.postInit();
    await bothStarted.promise;

    // The second account finishes first. Its SDK subprocess has not spawned yet.
    bRead.resolve({
      value: 'b-access', scopes: ['user:inference', 'user:mcp_servers'],
      expiresAt: Date.now() + 3600000,
    });
    expect(await bInit).toEqual({ authInjected: true });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('b-access');

    aRead.resolve({ value: 'a-access', scopes: ['user:inference'], expiresAt: Date.now() + 3600000 });
    expect(await aInit).toEqual({ authInjected: true });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('a-access');
    expect(process.env.CLAUDE_CODE_OAUTH_SCOPES).toBe('user:inference');

    // Later global credentials also must not override either pinned OAuth login.
    process.env.ANTHROPIC_API_KEY = 'another-connection-api-key';
    process.env.ANTHROPIC_AUTH_TOKEN = 'another-connection-auth-token';
    process.env.ANTHROPIC_BASE_URL = 'https://another.example.invalid';
    const bEnv = buildClaudeSubprocessEnv(b.config.envOverrides);
    const aEnv = buildClaudeSubprocessEnv(a.config.envOverrides);

    expect(bEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('b-access');
    expect(bEnv.CLAUDE_CODE_OAUTH_SCOPES).toBe('user:inference user:mcp_servers');
    expect(aEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('a-access');
    expect(aEnv.CLAUDE_CODE_OAUTH_SCOPES).toBe('user:inference');
    for (const env of [aEnv, bEnv]) {
      expect(env.ANTHROPIC_API_KEY).toBe('');
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('');
      expect(env.ANTHROPIC_BASE_URL).toBe('');
    }
    expect(aEnv.CRAFT_SESSION_TEST).toBe('a');
    expect(bEnv.CRAFT_SESSION_TEST).toBe('b');
    expect(reads).toEqual(['a', 'b']);
  });
});
