import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionToolContext } from '../context.ts';
import { loadSourceConfig } from '../source-helpers.ts';
import type { SourceConfig, ToolResult } from '../types.ts';
import { handleCredentialPrompt } from './credential-prompt.ts';
import { handleGoogleOAuthTrigger, handleMicrosoftOAuthTrigger, handleSlackOAuthTrigger, handleSourceOAuthTrigger } from './source-oauth.ts';
import { handleSourceTest } from './source-test.ts';

let workspacePath: string;
let effects: string[];

beforeEach(() => {
  workspacePath = mkdtempSync(join(tmpdir(), 'source-management-policy-'));
  effects = [];
});

afterEach(() => rmSync(workspacePath, { recursive: true, force: true }));

function writeSource(overrides: Partial<SourceConfig> = {}): string {
  const source: SourceConfig = {
    id: 'test', name: 'Test source', slug: 'test', type: 'mcp',
    enabled: false, provider: 'test', isAuthenticated: true,
    icon: 'https://example.invalid/icon.png',
    mcp: { transport: 'http', url: 'https://example.invalid/mcp', authType: 'oauth' },
    ...overrides,
  };
  const folder = join(workspacePath, 'sources', source.slug);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, 'config.json');
  writeFileSync(file, JSON.stringify(source));
  return file;
}

function context(mcpManagement?: 'claudeai'): SessionToolContext {
  return {
    sessionId: 'test', workspacePath, mcpManagement,
    sourcesPath: join(workspacePath, 'sources'),
    skillsPath: join(workspacePath, 'skills'),
    plansFolderPath: join(workspacePath, 'plans'),
    callbacks: {
      onPlanSubmitted: () => {},
      onAuthRequest: () => { effects.push('auth'); },
    },
    fs: {
      exists: existsSync,
      readFile: path => readFileSync(path, 'utf-8'),
      readFileBuffer: readFileSync,
      writeFile: (path, content) => { effects.push('write'); writeFileSync(path, content); },
      isDirectory: path => existsSync(path) && statSync(path).isDirectory(),
      readdir: readdirSync,
      stat: statSync,
    },
    loadSourceConfig: slug => loadSourceConfig(workspacePath, slug),
    saveSourceConfig: source => {
      effects.push('save');
      writeFileSync(join(workspacePath, 'sources', source.slug, 'config.json'), JSON.stringify(source));
    },
    credentialManager: {
      hasValidCredentials: async () => { effects.push('credentials'); return true; },
      getToken: async () => { effects.push('token'); return null; },
      refresh: async () => { effects.push('refresh'); return null; },
    },
    validateMcpConnection: async () => { effects.push('http'); return { success: true }; },
    validateStdioMcpConnection: async () => { effects.push('stdio'); return { success: true }; },
    isIconUrl: icon => icon.startsWith('https://'),
    downloadSourceIcon: async () => { effects.push('icon'); return null; },
    activateSourceInSession: async () => { effects.push('activate'); return { ok: true }; },
  };
}

function text(result: ToolResult): string {
  return result.content.map(part => part.type === 'text' ? part.text : '').join('\n');
}

const authTools = [
  { name: 'source_oauth_trigger', provider: 'test', handler: handleSourceOAuthTrigger },
  { name: 'source_google_oauth_trigger', provider: 'google', handler: handleGoogleOAuthTrigger },
  { name: 'source_slack_oauth_trigger', provider: 'slack', handler: handleSlackOAuthTrigger },
  { name: 'source_microsoft_oauth_trigger', provider: 'microsoft', handler: handleMicrosoftOAuthTrigger },
];

describe('Claude account MCP source ownership', () => {
  const protectedTools = [
    { name: 'source_test (HTTP)', provider: 'test', handler: handleSourceTest },
    ...authTools,
    {
      name: 'source_credential_prompt', provider: 'test',
      handler: (ctx: SessionToolContext, args: { sourceSlug: string }) => handleCredentialPrompt(ctx, { ...args, mode: 'bearer' }),
    },
  ];

  for (const { name, provider, handler } of protectedTools) {
    it(`blocks ${name} before credentials, network, auth, or configuration changes`, async () => {
      const file = writeSource({ provider });
      const original = readFileSync(file, 'utf-8');
      const result = await handler(context('claudeai'), { sourceSlug: 'test' });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('https://claude.ai/customize/connectors');
      expect(effects).toEqual([]);
      expect(readFileSync(file, 'utf-8')).toBe(original);
    });
  }

  it('does not start a local MCP process to test a stdio source', async () => {
    writeSource({ mcp: { transport: 'stdio', command: 'unused-command' } });
    const result = await handleSourceTest(context('claudeai'), { sourceSlug: 'test' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('managed in claude.ai');
    expect(effects).toEqual([]);
  });

  for (const { name, provider, handler } of authTools) {
    it(`retains API authentication through ${name}`, async () => {
      writeSource({
        type: 'api', provider, mcp: undefined, icon: '🧪',
        api: { baseUrl: 'https://example.invalid', authType: 'oauth', microsoftService: provider === 'microsoft' ? 'outlook' : undefined },
      });
      const result = await handler(context('claudeai'), { sourceSlug: 'test' });
      expect(result.isError).not.toBe(true);
      expect(effects).toContain('auth');
      expect(text(result)).not.toContain('managed in claude.ai');
    });
  }

  it('retains API credential prompts', async () => {
    writeSource({ type: 'api', mcp: undefined, api: { baseUrl: 'https://example.invalid', authType: 'bearer' } });
    const result = await handleCredentialPrompt(context('claudeai'), { sourceSlug: 'test', mode: 'bearer' });
    expect(result.isError).not.toBe(true);
    expect(effects).toEqual(['auth']);
  });

  it('retains API connection tests and activation', async () => {
    writeSource({ type: 'api', mcp: undefined, api: { baseUrl: 'https://example.invalid', authType: 'none' }, icon: '🧪' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () => { effects.push('fetch'); return new Response('{}'); },
      { preconnect: originalFetch.preconnect },
    );
    try {
      const result = await handleSourceTest(context('claudeai'), { sourceSlug: 'test' });
      expect(result.isError).not.toBe(true);
      expect(effects).toContain('fetch');
      expect(effects).toContain('activate');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retains local source validation', async () => {
    writeSource({ type: 'local', mcp: undefined, local: { path: workspacePath }, icon: '🧪' });
    const result = await handleSourceTest(context('claudeai'), { sourceSlug: 'test' });
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain('Local path exists');
    expect(effects).toContain('save');
  });

  it('retains Craft MCP authentication for other connections', async () => {
    writeSource();
    const result = await handleSourceOAuthTrigger(context(), { sourceSlug: 'test' });
    expect(result.isError).not.toBe(true);
    expect(effects).toEqual(['refresh', 'auth']);
  });

  it('retains Craft MCP credential prompts for other connections', async () => {
    writeSource();
    const result = await handleCredentialPrompt(context(), { sourceSlug: 'test', mode: 'bearer' });
    expect(result.isError).not.toBe(true);
    expect(effects).toEqual(['auth']);
  });

  it('retains Craft MCP validation for other connections', async () => {
    writeSource({ icon: '🧪', mcp: { transport: 'stdio', command: 'unused-command' } });
    const result = await handleSourceTest(context(), { sourceSlug: 'test' });
    expect(result.isError).not.toBe(true);
    expect(effects).toContain('stdio');
    expect(effects).toContain('activate');
  });
});
