import { afterEach, describe, expect, it } from 'bun:test';
import { clearOAuthState, exchangeClaudeCode, prepareClaudeOAuth } from '../claude-oauth.ts';
import { refreshClaudeToken } from '../claude-token.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  clearOAuthState();
  globalThis.fetch = originalFetch;
});

function respondWithTokens(fields: Record<string, unknown> = {}): void {
  globalThis.fetch = Object.assign(async () => Response.json({
    access_token: 'issued-access-token',
    refresh_token: 'issued-refresh-token',
    expires_in: 3600,
    ...fields,
  }), { preconnect: originalFetch.preconnect });
}

describe('Claude OAuth authorization scopes', () => {
  it('requests connector access alongside the existing Claude permissions', () => {
    const url = new URL(prepareClaudeOAuth());
    const scopes = url.searchParams.get('scope')?.split(' ');

    expect(scopes).toEqual([
      'org:create_api_key',
      'user:profile',
      'user:inference',
      'user:mcp_servers',
    ]);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('records only the scopes actually granted during exchange', async () => {
    prepareClaudeOAuth();
    respondWithTokens({ scope: '  user:profile\tuser:inference  ' });

    const tokens = await exchangeClaudeCode('authorization-code');

    expect(tokens.scopes).toEqual(['user:profile', 'user:inference']);
    expect(tokens.scopes).not.toContain('user:mcp_servers');
  });

  it('does not infer a grant from the requested scopes when exchange omits it', async () => {
    prepareClaudeOAuth();
    respondWithTokens();

    expect((await exchangeClaudeCode('authorization-code')).scopes).toBeUndefined();
  });

  it('keeps an explicitly empty exchange grant empty', async () => {
    prepareClaudeOAuth();
    respondWithTokens({ scope: '  ' });

    expect((await exchangeClaudeCode('authorization-code')).scopes).toEqual([]);
  });

  it('reads the scopes returned by refresh without adding requested permissions', async () => {
    respondWithTokens({ scope: 'user:inference\nuser:mcp_servers' });

    expect((await refreshClaudeToken('previous-refresh-token')).scopes).toEqual([
      'user:inference', 'user:mcp_servers',
    ]);
  });

  it('leaves an omitted refresh grant unknown and retains an unrotated refresh token', async () => {
    respondWithTokens({ refresh_token: undefined });

    const tokens = await refreshClaudeToken('previous-refresh-token');

    expect(tokens.scopes).toBeUndefined();
    expect(tokens.refreshToken).toBe('previous-refresh-token');
  });
});
