import { afterEach, describe, expect, it } from 'bun:test';
import { clearOAuthState, prepareClaudeOAuth } from '../claude-oauth.ts';

afterEach(clearOAuthState);

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
});
