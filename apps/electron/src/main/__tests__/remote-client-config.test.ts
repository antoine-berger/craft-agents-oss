import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPersistentRemoteClientConfig, readPersistentRemoteClientConfig, remoteClientWindowOptions } from '../remote-client-config'

const roots: string[] = []

test('restores a hybrid window using the server workspace while preserving the selected chat', () => {
  const restored = remoteClientWindowOptions('remote-workspace', {
    url: 'file:///app/index.html?workspaceId=local-workspace&ws=cloud&route=allSessions%2Fsession%2Fchat-1', focused: true,
  })
  const url = new URL(restored.restoreUrl!)
  expect(restored.workspaceId).toBe('remote-workspace')
  expect(url.searchParams.get('workspaceId')).toBe('remote-workspace')
  expect(url.searchParams.get('ws')).toBe('remote-workspace')
  expect(url.searchParams.get('route')).toBe('allSessions/session/chat-1')
  expect(restored.focused).toBe(true)
})

test('a missing or invalid saved URL opens the selected server workspace', () => {
  expect(remoteClientWindowOptions('remote-workspace').restoreUrl).toBeUndefined()
  expect(remoteClientWindowOptions('remote-workspace', { url: 'invalid' }).workspaceId).toBe('remote-workspace')
})
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(data: unknown, mode = 0o600) {
  const root = mkdtempSync(join(tmpdir(), 'craft-remote-config-'))
  roots.push(root)
  const dir = join(root, '.craft-agent')
  mkdirSync(dir)
  const file = join(dir, 'remote-client.json')
  writeFileSync(file, JSON.stringify(data), { mode })
  chmodSync(file, mode)
  return root
}

test('Dock start loads a private WSS connection and workspace', () => {
  const home = fixture({ url: 'wss://agent.example:9100', token: 'secret', workspaceId: 'ws1' })
  const env: NodeJS.ProcessEnv = {}
  applyPersistentRemoteClientConfig(env, home)
  expect(env.CRAFT_SERVER_URL).toBe('wss://agent.example:9100/')
  expect(env.CRAFT_SERVER_TOKEN).toBe('secret')
  expect(env.CRAFT_WORKSPACE_ID).toBe('ws1')
})

test('explicit environment overrides persisted settings', () => {
  const home = fixture({ url: 'wss://agent.example', token: 'persisted' })
  const env: NodeJS.ProcessEnv = { CRAFT_SERVER_URL: 'ws://localhost:9100', CRAFT_SERVER_TOKEN: 'override' }
  applyPersistentRemoteClientConfig(env, home)
  expect(env.CRAFT_SERVER_TOKEN).toBe('override')
})

test('reject insecure remote transport and shared token files', () => {
  const home = fixture({ url: 'ws://example.com:9100', token: 'secret' })
  expect(() => readPersistentRemoteClientConfig({}, home)).toThrow('wss://')
  const shared = fixture({ url: 'wss://example.com', token: 'secret' }, 0o644)
  if (process.platform !== 'win32') expect(() => readPersistentRemoteClientConfig({}, shared)).toThrow('chmod 600')
})
