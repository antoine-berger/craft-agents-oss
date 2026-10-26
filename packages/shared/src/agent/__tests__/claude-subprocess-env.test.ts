import { afterEach, describe, expect, it } from 'bun:test';
import { buildClaudeSubprocessEnv } from '../options.ts';

const ENV_KEYS = [
  'CLAUDE_CODE_ENABLE_TODO_TOOLS', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES',
] as const;
const originalEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('buildClaudeSubprocessEnv', () => {
  it('keeps the task-tracking tools available on every model (SDK 0.3.268 default change)', () => {
    delete process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS;
    expect(buildClaudeSubprocessEnv().CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1');
  });

  it('respects an explicit opt-out from the process environment', () => {
    process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '0';
    expect(buildClaudeSubprocessEnv().CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('0');
  });

  it('respects a per-session override', () => {
    delete process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS;
    expect(buildClaudeSubprocessEnv({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '0' }).CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('0');
  });

  it.each(['selected-account-token', ''])('never inherits global grants when a session supplies its own token (%j)', token => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'global-account-token';
    process.env.CLAUDE_CODE_OAUTH_SCOPES = 'user:inference user:mcp_servers';

    const env = buildClaudeSubprocessEnv({ CLAUDE_CODE_OAUTH_TOKEN: token });

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
    expect(env.CLAUDE_CODE_OAUTH_SCOPES).toBe('user:inference');
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('global-account-token');
    expect(process.env.CLAUDE_CODE_OAUTH_SCOPES).toBe('user:inference user:mcp_servers');
  });

  it('pins the selected account grant without broadening it from process env', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'global-account-token';
    process.env.CLAUDE_CODE_OAUTH_SCOPES = 'user:inference user:profile user:mcp_servers';

    const env = buildClaudeSubprocessEnv({
      CLAUDE_CODE_OAUTH_TOKEN: 'selected-account-token',
      CLAUDE_CODE_OAUTH_SCOPES: 'user:inference user:profile',
    });

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('selected-account-token');
    expect(env.CLAUDE_CODE_OAUTH_SCOPES).toBe('user:inference user:profile');
  });
});
