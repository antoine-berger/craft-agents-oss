import { describe, expect, it, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = mkdtempSync(join(tmpdir(), 'craft-proxy-routing-'))
process.env.CRAFT_CONFIG_DIR = root
copyFileSync(join(process.cwd(), 'apps/electron/resources/config-defaults.json'), join(root, 'config-defaults.json'))
const connections = [
  { slug: 'native-claude', name: 'Native Claude', providerType: 'anthropic', authType: 'oauth' },
  { slug: 'native-gpt', name: 'Native GPT', providerType: 'pi', piAuthProvider: 'openai-codex', authType: 'oauth' },
  { slug: 'other', name: 'Other', providerType: 'pi', piAuthProvider: 'google', authType: 'api_key' },
  { slug: 'cli-proxy-claude', name: 'Claude pool', providerType: 'anthropic', authType: 'api_key_with_endpoint' },
  { slug: 'cli-proxy-codex', name: 'GPT pool', providerType: 'pi_compat', piAuthProvider: 'openai', authType: 'api_key_with_endpoint' },
].map(connection => ({ ...connection, createdAt: Date.now(), models: ['test-model'] }))
const save = (routing: boolean) => writeFileSync(join(root,'config.json'), JSON.stringify({ workspaces: [], llmConnections: connections, defaultLlmConnection: 'native-claude', cliProxyRoutingAll: routing }))
save(true)
const { resolveSessionConnection } = await import('../factory')
afterAll(() => rmSync(root, { recursive: true, force: true }))
describe('all-proxy connection resolution', () => {
 it('routes explicit legacy session and workspace references through their pools', () => {
  expect(resolveSessionConnection('native-claude')?.slug).toBe('cli-proxy-claude')
  expect(resolveSessionConnection(undefined,'native-gpt')?.slug).toBe('cli-proxy-codex')
  expect(resolveSessionConnection()?.slug).toBe('cli-proxy-claude')
 })
 it('keeps pooled connections and refuses unsupported direct providers', () => {
  expect(resolveSessionConnection('cli-proxy-codex')?.slug).toBe('cli-proxy-codex')
  expect(() => resolveSessionConnection('other')).toThrow('not available through CLIProxyAPI')
 })
 it('preserves normal direct resolution when all-proxy mode is off', () => {
  save(false)
  expect(resolveSessionConnection('native-claude')?.slug).toBe('native-claude')
  expect(resolveSessionConnection('other')?.slug).toBe('other')
 })
})
