// Run separately: CONFIG_DIR is resolved once when shared modules load.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { SessionToolProfileOptions } from '../session-scoped-tools.ts';

const originalConfigDir = process.env.CRAFT_CONFIG_DIR;
const configRoot = mkdtempSync(join(tmpdir(), 'session-tools-mcp-config-'));
process.env.CRAFT_CONFIG_DIR = configRoot;
writeFileSync(join(configRoot, 'config-defaults.json'), JSON.stringify({
  defaults: { browserToolEnabled: false }, workspaceDefaults: {},
}));

const {
  cleanupSessionScopedTools,
  getSessionScopedTools,
  registerSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} = await import('../session-scoped-tools.ts');

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CRAFT_CONFIG_DIR;
  else process.env.CRAFT_CONFIG_DIR = originalConfigDir;
  rmSync(configRoot, { recursive: true, force: true });
});

const SESSION = 'session-tools-mcp-management';
let workspacePath: string;
let authRequests: unknown[];

beforeEach(() => {
  workspacePath = mkdtempSync(join(tmpdir(), 'session-tools-mcp-management-'));
  authRequests = [];
  registerSessionScopedToolCallbacks(SESSION, { onAuthRequest: request => { authRequests.push(request); } });
  for (const type of ['mcp', 'api'] as const) {
    const folder = join(workspacePath, 'sources', `${type}-source`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'config.json'), JSON.stringify({
      id: type, name: `${type} source`, slug: `${type}-source`, type,
      enabled: true, provider: 'test',
      ...(type === 'mcp'
        ? { mcp: { transport: 'http', url: 'https://example.invalid/mcp', authType: 'bearer' } }
        : { api: { baseUrl: 'https://example.invalid', authType: 'bearer' } }),
    }));
  }
});

afterEach(() => {
  cleanupSessionScopedTools(SESSION);
  unregisterSessionScopedToolCallbacks(SESSION);
  rmSync(workspacePath, { recursive: true, force: true });
});

async function requestCredential(sourceSlug: string, options?: SessionToolProfileOptions) {
  const server = getSessionScopedTools(SESSION, workspacePath, undefined, options);
  const client = new Client({ name: 'mcp-management-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
    return await client.callTool({ name: 'source_credential_prompt', arguments: { sourceSlug, mode: 'bearer' } });
  } finally {
    await Promise.allSettled([client.close(), server.instance.close()]);
  }
}

describe('Session tool adapter MCP ownership policy', () => {
  for (const profile of [undefined, 'coding'] as const) {
    it(`isolates cached policies when switching connections (${profile ?? 'default'} profile)`, async () => {
      const options = { profile, hasEnabledSources: true };
      const before = await requestCredential('mcp-source', options);
      expect(before.isError).not.toBe(true);
      expect(authRequests).toHaveLength(1);

      const restricted = await requestCredential('mcp-source', { ...options, mcpManagement: 'claudeai' });
      expect(restricted.isError).toBe(true);
      expect(JSON.stringify(restricted.content)).toContain('https://claude.ai/customize/connectors');
      expect(authRequests).toHaveLength(1);

      const after = await requestCredential('mcp-source', options);
      expect(after.isError).not.toBe(true);
      expect(authRequests).toHaveLength(2);
    });
  }

  it('preserves API credential tools for Claude account connections', async () => {
    const result = await requestCredential('api-source', { mcpManagement: 'claudeai' });
    expect(result.isError).not.toBe(true);
    expect(authRequests).toHaveLength(1);
  });
});
