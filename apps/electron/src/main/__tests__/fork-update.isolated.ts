import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const root = mkdtempSync(join(tmpdir(), 'craft-update-consent-'))
const previousConfig = process.env.CRAFT_CONFIG_DIR
process.env.CRAFT_CONFIG_DIR = root
writeFileSync(join(root, 'fork-update.json'), JSON.stringify({ host: 'root@10.0.0.160', jump: 'proxy' }), { mode: 0o600 })
const calls: string[][] = []
const answers: number[] = []
let fetchCount = 0
const originalFetch = globalThis.fetch
const fakeExec = Object.assign(() => { throw new Error('Unexpected callback exec') }, {
  [promisify.custom]: async (_file: string, args: string[]) => {
    calls.push(args)
    return { stdout: JSON.stringify({ currentVersion: args.includes('apply') ? '0.15.6' : '0.15.5', available: !args.includes('apply'), staged: true }), stderr: '' }
  },
})
mock.module('node:child_process', () => ({ execFile: fakeExec, spawn: () => { throw new Error('Must not spawn a client installer') } }))
mock.module('electron', () => ({
  app: { getVersion: () => '0.15.6', getPath: () => root, exit: () => { throw new Error('Must not exit the client') } },
  dialog: { showMessageBox: async () => ({ response: answers.shift() ?? 0 }) },
}))
globalThis.fetch = (async () => {
  fetchCount++
  return Response.json({ schema: 1, repository: 'antoine-berger/craft-agents-oss', version: '0.15.6', assets: Object.fromEntries([
    ['darwin-arm64', 'Craft-Agents-arm64.zip'], ['server-linux-x64', 'craft-server-linux-x64.tar.gz'],
  ].map(([key, file]) => [key, { url: `https://github.com/antoine-berger/craft-agents-oss/releases/download/fork-v0.15.6/${file}`, sha256: 'a'.repeat(64), size: 100 }])) })
}) as typeof fetch
const updater = await import('../fork-update')
beforeEach(() => { calls.length = 0; answers.length = 0; fetchCount = 0 })
afterAll(() => {
  globalThis.fetch = originalFetch
  if (previousConfig === undefined) delete process.env.CRAFT_CONFIG_DIR
  else process.env.CRAFT_CONFIG_DIR = previousConfig
  rmSync(root, { recursive: true, force: true })
})

test('launch performs no network, SSH, download or restart', async () => {
  expect((await updater.checkForUpdatesOnLaunch()).action).toBe('skipped')
  expect(fetchCount).toBe(0); expect(calls).toHaveLength(0)
})
test('check prepares a server without applying or restarting it', async () => {
  expect((await updater.checkForUpdates()).downloadState).toBe('ready')
  expect(calls.map(args => args.includes('stage') ? 'stage' : 'check')).toEqual(['check', 'stage'])
  expect(calls.some(args => args.includes('--authorize-restart'))).toBe(false)
})
test('cancelling either native confirmation cannot apply the server', async () => {
  await updater.checkForUpdates(); calls.length = 0
  answers.push(0); await updater.installUpdate()
  expect(calls).toHaveLength(0)
  answers.push(1, 0); await updater.installUpdate()
  expect(calls).toHaveLength(0)
})
test('only explicit native restart confirmation sends apply authorization', async () => {
  await updater.checkForUpdates(); calls.length = 0
  answers.push(1, 1, 0); await updater.installUpdate()
  expect(calls).toHaveLength(1)
  expect(calls[0]).toContain('apply'); expect(calls[0]).toContain('--authorize-restart')
  expect(calls[0]).toContain('StrictHostKeyChecking=yes')
})
