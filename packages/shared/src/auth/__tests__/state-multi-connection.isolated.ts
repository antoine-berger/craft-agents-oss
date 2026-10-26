/**
 * Run in its own process: module mocks must not replace credential/config
 * modules for the rest of the shared package's tests.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { LlmConnection } from '../../config/llm-connections.ts';

interface Credentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  source?: 'native' | 'cli';
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function connection(slug: string): LlmConnection {
  return { slug, name: slug, providerType: 'anthropic', authType: 'oauth', createdAt: 0 };
}

const credentials = new Map<string, Credentials>();
let legacyCredentials: Credentials | null;
let defaultSlug: string | null;
let connections: LlmConnection[];
let readCredentials: (slug: string) => Promise<Credentials | null>;
const credentialReads: string[] = [];
const legacyWrites: Credentials[] = [];
const deletedConnections: string[] = [];
const refreshRequests: string[] = [];
let respondToRefresh: (refreshToken: string) => Promise<Response>;

const manager = {
  getLlmOAuth: async (slug: string) => {
    credentialReads.push(slug);
    return readCredentials(slug);
  },
  setLlmOAuth: async (slug: string, value: Credentials) => {
    credentials.set(slug, { ...value });
  },
  getClaudeOAuthCredentials: async () => legacyCredentials,
  setClaudeOAuthCredentials: async (value: Credentials) => {
    legacyCredentials = { ...value };
    legacyWrites.push(value);
  },
  deleteLlmCredentials: async (slug: string) => {
    credentials.delete(slug);
    deletedConnections.push(slug);
  },
};

mock.module('../../credentials/index.ts', () => ({ getCredentialManager: () => manager }));
mock.module('../../config/storage.ts', () => ({
  loadStoredConfig: () => ({ llmConnections: connections, defaultLlmConnection: defaultSlug }),
  getDefaultLlmConnection: () => defaultSlug,
  getLlmConnection: (slug: string) => connections.find((item) => item.slug === slug) ?? null,
  getActiveWorkspace: () => null,
}));

const { getValidClaudeOAuthToken, _resetRefreshMutex } = await import('../state.ts');
const originalFetch = globalThis.fetch;

function refreshedResponse(account: string): Response {
  return Response.json({
    access_token: `${account}-new-access`,
    refresh_token: `${account}-new-refresh`,
    expires_in: 3600,
  });
}

function expire(slug: string): void {
  credentials.get(slug)!.expiresAt = Date.now() - 1000;
}

beforeEach(() => {
  _resetRefreshMutex();
  credentials.clear();
  for (const account of ['a', 'b']) {
    credentials.set(account, {
      accessToken: `${account}-access`,
      refreshToken: `${account}-refresh`,
      expiresAt: Date.now() + 3600000,
    });
  }
  // The global slot contains the last sign-in, not necessarily the default.
  legacyCredentials = { ...credentials.get('b')!, source: 'native' };
  defaultSlug = 'a';
  connections = [connection('a'), connection('b')];
  readCredentials = async (slug) => credentials.get(slug) ?? null;
  credentialReads.length = 0;
  legacyWrites.length = 0;
  deletedConnections.length = 0;
  refreshRequests.length = 0;
  respondToRefresh = async (refreshToken) => refreshedResponse(refreshToken[0]!);
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(init!.body as string) as { refresh_token: string };
    refreshRequests.push(request.refresh_token);
    return respondToRefresh(request.refresh_token);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetRefreshMutex();
});

describe('Claude OAuth account selection', () => {
  it('uses each connection token even when the global slot belongs to another account', async () => {
    expect(await getValidClaudeOAuthToken('a')).toEqual({ accessToken: 'a-access' });
    expect(await getValidClaudeOAuthToken('b')).toEqual({ accessToken: 'b-access' });
    expect(refreshRequests).toEqual([]);
  });

  it('does not give global credentials to a missing secondary account', async () => {
    credentials.delete('b');
    expect(await getValidClaudeOAuthToken('b')).toEqual({ accessToken: null });
  });

  it('does not give ambiguous global credentials to a missing default account', async () => {
    credentials.delete('a');
    expect(await getValidClaudeOAuthToken('a')).toEqual({ accessToken: null });
  });

  it('supports the legacy default when only one Claude OAuth account is configured', async () => {
    credentials.delete('a');
    connections = [connection('a'), {
      slug: 'openai', name: 'OpenAI', providerType: 'pi', authType: 'oauth', createdAt: 0,
    }];
    legacyCredentials = { accessToken: 'legacy-access' };
    expect(await getValidClaudeOAuthToken('a')).toEqual({ accessToken: 'legacy-access' });
  });

  it('does not use legacy credentials for an unknown connection', async () => {
    connections = [connection('a')];
    expect(await getValidClaudeOAuthToken('missing')).toEqual({ accessToken: null });
  });

  it('respects an explicitly empty connection credential instead of falling back', async () => {
    credentials.set('a', { accessToken: '' });
    connections = [connection('a')];
    expect(await getValidClaudeOAuthToken('a')).toEqual({ accessToken: null });
  });

  it('does not substitute another account when the selected token cannot be refreshed', async () => {
    credentials.set('a', { accessToken: 'a-access', expiresAt: Date.now() - 1000 });
    expect(await getValidClaudeOAuthToken('a')).toEqual({ accessToken: null });
    expect(refreshRequests).toEqual([]);
  });
});

describe('Claude OAuth refresh isolation', () => {
  it('refreshes a secondary account without changing the default or legacy slot', async () => {
    expire('b');
    const previousLegacy = { ...legacyCredentials! };
    expect(await getValidClaudeOAuthToken('b')).toEqual({ accessToken: 'b-new-access' });
    expect(refreshRequests).toEqual(['b-refresh']);
    expect(credentials.get('b')?.refreshToken).toBe('b-new-refresh');
    expect(credentials.get('a')?.accessToken).toBe('a-access');
    expect(legacyCredentials).toEqual(previousLegacy);
    expect(legacyWrites).toEqual([]);
  });

  it('mirrors only the default account refresh to the legacy slot', async () => {
    expire('a');
    expect(await getValidClaudeOAuthToken('a')).toEqual({ accessToken: 'a-new-access' });
    expect(credentials.get('a')?.accessToken).toBe('a-new-access');
    expect(legacyCredentials?.accessToken).toBe('a-new-access');
    expect(legacyCredentials?.source).toBe('native');
    expect(credentials.get('b')?.accessToken).toBe('b-access');
  });

  it('migrates a successfully refreshed legacy account into connection storage', async () => {
    credentials.delete('a');
    connections = [connection('a')];
    legacyCredentials = {
      accessToken: 'legacy-access', refreshToken: 'a-refresh', expiresAt: 1, source: 'cli',
      scopes: ['user:inference', 'user:mcp_servers'],
    };
    expect(await getValidClaudeOAuthToken('a')).toEqual({
      accessToken: 'a-new-access', scopes: ['user:inference', 'user:mcp_servers'],
    });
    expect(credentials.get('a')?.refreshToken).toBe('a-new-refresh');
    expect(credentials.get('a')?.scopes).toEqual(['user:inference', 'user:mcp_servers']);
    expect(legacyCredentials?.source).toBe('native');
  });

  it('clears only the affected secondary account after invalid_grant', async () => {
    expire('b');
    respondToRefresh = async () => Response.json({ error: 'invalid_grant' }, { status: 400 });
    const result = await getValidClaudeOAuthToken('b');
    expect(result.accessToken).toBeNull();
    expect(result.migrationRequired).toBeUndefined();
    expect(deletedConnections).toEqual(['b']);
    expect(credentials.get('a')?.accessToken).toBe('a-access');
    expect(legacyWrites).toEqual([]);
  });

  it('clears the default and its legacy mirror after invalid_grant', async () => {
    expire('a');
    legacyCredentials = { ...credentials.get('a')!, source: 'native' };
    respondToRefresh = async () => Response.json({ error: 'invalid_grant' }, { status: 400 });
    expect((await getValidClaudeOAuthToken('a')).accessToken).toBeNull();
    expect(deletedConnections).toEqual(['a']);
    expect(legacyCredentials?.accessToken).toBe('');
    expect(credentials.get('b')?.accessToken).toBe('b-access');
  });

  it('preserves credentials after a network failure and releases the lock for retry', async () => {
    expire('b');
    respondToRefresh = async () => { throw new Error('network unavailable'); };
    expect((await getValidClaudeOAuthToken('b')).accessToken).toBeNull();
    expect(credentials.get('b')?.refreshToken).toBe('b-refresh');
    expect(deletedConnections).toEqual([]);
    expect(legacyWrites).toEqual([]);

    respondToRefresh = async () => refreshedResponse('b');
    expect(await getValidClaudeOAuthToken('b')).toEqual({ accessToken: 'b-new-access' });
    expect(refreshRequests).toEqual(['b-refresh', 'b-refresh']);
  });
});

describe('Claude OAuth granted scopes', () => {
  it('returns only the selected account scopes despite a different global grant', async () => {
    credentials.get('a')!.scopes = ['user:inference'];
    credentials.get('b')!.scopes = ['user:inference', 'user:mcp_servers'];
    legacyCredentials = { ...credentials.get('b')!, source: 'native' };

    expect(await getValidClaudeOAuthToken('a')).toEqual({
      accessToken: 'a-access', scopes: ['user:inference'],
    });
    expect(await getValidClaudeOAuthToken('b')).toEqual({
      accessToken: 'b-access', scopes: ['user:inference', 'user:mcp_servers'],
    });
  });

  it('keeps legacy unknown scopes unknown on read and refresh without borrowing the global grant', async () => {
    legacyCredentials!.scopes = ['user:inference', 'user:mcp_servers'];

    expect(await getValidClaudeOAuthToken('a')).toEqual({ accessToken: 'a-access' });
    expire('a');
    expect(await getValidClaudeOAuthToken('a')).toEqual({ accessToken: 'a-new-access' });
    expect(credentials.get('a')?.scopes).toBeUndefined();
    expect(legacyCredentials?.scopes).toBeUndefined();
  });

  it('preserves the same account grant when refresh omits scope', async () => {
    const scopes = ['user:inference', 'user:mcp_servers'];
    credentials.get('a')!.scopes = scopes;
    expire('a');

    expect(await getValidClaudeOAuthToken('a')).toEqual({ accessToken: 'a-new-access', scopes });
    expect(credentials.get('a')?.scopes).toEqual(scopes);
    expect(legacyCredentials?.scopes).toEqual(scopes);
  });

  it('replaces previous permissions with a narrower grant returned by refresh', async () => {
    credentials.get('a')!.scopes = ['user:inference', 'user:mcp_servers'];
    expire('a');
    respondToRefresh = async () => Response.json({
      access_token: 'a-new-access', expires_in: 3600, scope: 'user:inference',
    });

    expect(await getValidClaudeOAuthToken('a')).toEqual({
      accessToken: 'a-new-access', scopes: ['user:inference'],
    });
    expect(credentials.get('a')?.scopes).toEqual(['user:inference']);
    expect(legacyCredentials?.scopes).toEqual(['user:inference']);
  });

  it('does not restore an old grant when refresh explicitly returns no permissions', async () => {
    credentials.get('b')!.scopes = ['user:inference', 'user:mcp_servers'];
    expire('b');
    respondToRefresh = async () => Response.json({ access_token: 'b-new-access', scope: '' });

    expect(await getValidClaudeOAuthToken('b')).toEqual({ accessToken: 'b-new-access', scopes: [] });
    expect(credentials.get('b')?.scopes).toEqual([]);
    expect(legacyWrites).toEqual([]);
  });
});

describe('Claude OAuth concurrent requests', () => {
  it('locks before reading credentials so concurrent callers cannot refresh stale copies', async () => {
    expire('a');
    const read = deferred<Credentials | null>();
    readCredentials = () => read.promise;
    const first = getValidClaudeOAuthToken('a');
    const second = getValidClaudeOAuthToken('a');
    expect(credentialReads).toEqual(['a']);
    read.resolve({ ...credentials.get('a')! });

    expect(await Promise.all([first, second])).toEqual([
      { accessToken: 'a-new-access' }, { accessToken: 'a-new-access' },
    ]);
    expect(refreshRequests).toEqual(['a-refresh']);
  });

  it('refreshes different accounts independently and returns the correct token to each caller', async () => {
    credentials.get('a')!.scopes = ['user:inference'];
    credentials.get('b')!.scopes = ['user:inference', 'user:mcp_servers'];
    expire('a');
    expire('b');
    const aStarted = deferred<void>();
    const bStarted = deferred<void>();
    const aResponse = deferred<Response>();
    const bResponse = deferred<Response>();
    respondToRefresh = (token) => {
      if (token === 'a-refresh') {
        aStarted.resolve();
        return aResponse.promise;
      }
      bStarted.resolve();
      return bResponse.promise;
    };
    let aFinished = false;
    const a = getValidClaudeOAuthToken('a').then((result) => { aFinished = true; return result; });
    const b = getValidClaudeOAuthToken('b');
    await Promise.all([aStarted.promise, bStarted.promise]);

    bResponse.resolve(refreshedResponse('b'));
    expect(await b).toEqual({
      accessToken: 'b-new-access', scopes: ['user:inference', 'user:mcp_servers'],
    });
    expect(aFinished).toBe(false);
    aResponse.resolve(refreshedResponse('a'));
    expect(await a).toEqual({ accessToken: 'a-new-access', scopes: ['user:inference'] });
    expect(refreshRequests.sort()).toEqual(['a-refresh', 'b-refresh']);
    expect(legacyCredentials?.accessToken).toBe('a-new-access');
    expect(legacyCredentials?.scopes).toEqual(['user:inference']);
  });

  it('returns legacy migration information to every caller waiting on a failed refresh', async () => {
    credentials.delete('a');
    connections = [connection('a')];
    legacyCredentials = {
      accessToken: 'legacy-access', refreshToken: 'a-refresh', expiresAt: 1, source: 'cli',
    };
    const started = deferred<void>();
    const response = deferred<Response>();
    respondToRefresh = () => { started.resolve(); return response.promise; };
    const first = getValidClaudeOAuthToken('a');
    await started.promise;
    const second = getValidClaudeOAuthToken('a');
    response.resolve(Response.json({ error: 'invalid_grant' }, { status: 400 }));

    const results = await Promise.all([first, second]);
    expect(results[0]?.accessToken).toBeNull();
    expect(results[0]?.migrationRequired?.reason).toBe('legacy_token');
    expect(results[1]).toEqual(results[0]);
    expect(refreshRequests).toEqual(['a-refresh']);
    expect(deletedConnections).toEqual(['a']);
  });
});
