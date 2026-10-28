import { afterAll, expect, it, mock } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sdk from '@anthropic-ai/claude-agent-sdk'

const root = mkdtempSync(join(tmpdir(), 'craft-ship-proxy-'))
process.env.CRAFT_CONFIG_DIR = root
copyFileSync(join(process.cwd(), 'apps/electron/resources/config-defaults.json'), join(root, 'config-defaults.json'))
mkdirSync(join(root, 'cli-proxy'))
const proxyUrl = 'http://127.0.0.1:41234'
writeFileSync(join(root, 'cli-proxy', 'state.json'), JSON.stringify({ enabled: true, port: 41234 }))
const connections = [
  { slug: 'native-claude', authType: 'oauth' },
  { slug: 'cli-proxy-spoof', authType: 'api_key_with_endpoint', baseUrl: 'https://api.anthropic.com' },
  { slug: 'cli-proxy-claude', authType: 'api_key_with_endpoint', baseUrl: proxyUrl },
].map(connection => ({ ...connection, name: connection.slug, providerType: 'anthropic', createdAt: Date.now(), models: ['claude-opus-5-5'] }))
writeFileSync(join(root, 'config.json'), JSON.stringify({ workspaces: [], llmConnections: connections, defaultLlmConnection: 'native-claude', cliProxyRoutingAll: false }))
const modelQuery = mock(() => { throw new Error('No model calls allowed in this test') })
mock.module('@anthropic-ai/claude-agent-sdk', () => ({ ...sdk, query: modelQuery }))
const { ClaudeAgent } = await import('../claude-agent')
const { resolveSessionConnection } = await import('../backend/factory')
afterAll(() => rmSync(root, { recursive: true, force: true }))

function agent(slug: string, endpoint = ''): any {
  return Object.assign(Object.create(ClaudeAgent.prototype), {
    config: { connectionSlug: slug, envOverrides: { ANTHROPIC_BASE_URL: endpoint }, workspace: { rootPath: root } },
  })
}
const call = (target: any, role: string, model: string) => target.routeShipTool('Agent', { prompt: `Ship-Role: ${role}\nNeutral input`, model }, root)

it('production Ship hook blocks direct Claude roles while ordinary direct chats and Codex redirects remain available', () => {
  expect(resolveSessionConnection('native-claude')?.slug).toBe('native-claude')
  const direct = agent('native-claude')
  for (const [role, model] of [['e2e', 'sonnet'], ['performance', 'opus'], ['external-factcheck', 'opus']]) {
    const decision = call(direct, role!, model!)
    expect(decision.type).toBe('block')
    expect(decision.reason).toContain('Select the Claude · Account pool')
  }
  expect(direct.routeShipTool('Agent', { prompt: 'Ordinary research', model: 'sonnet' }, root)).toEqual({ type: 'allow' })
  expect(call(direct, 'bugs', 'opus').reason).toContain('--role bugs')
  expect(modelQuery).not.toHaveBeenCalled()
})

it('production hook allows managed-proxy native roles and pins their model, rejecting slug or runtime URL mismatches', () => {
  const pooled = agent('cli-proxy-claude', proxyUrl)
  expect(pooled.usesShipProxyConnection()).toBe(true)
  expect(call(pooled, 'e2e', 'sonnet')).toEqual({ type: 'allow' })
  expect(call(pooled, 'performance', 'opus')).toEqual({ type: 'allow' })
  expect(call(pooled, 'e2e', 'opus').input.model).toBe('sonnet')
  expect(call(agent('cli-proxy-spoof', 'https://api.anthropic.com'), 'e2e', 'sonnet').type).toBe('block')
  expect(call(agent('cli-proxy-claude', 'https://api.anthropic.com'), 'performance', 'opus').type).toBe('block')
  writeFileSync(join(root, 'cli-proxy', 'state.json'), JSON.stringify({ enabled: false, port: 41234 }))
  expect(call(pooled, 'e2e', 'sonnet').type).toBe('block')
  expect(modelQuery).not.toHaveBeenCalled()
})
