import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HandlerDeps } from '../handler-deps'
import type { HandlerFn, RpcServer } from '../../transport/types'

const root = mkdtempSync(join(tmpdir(), 'craft-adopt-rpc-'))
const previous = process.env.CRAFT_CONFIG_DIR
process.env.CRAFT_CONFIG_DIR = join(root, 'config')
mkdirSync(process.env.CRAFT_CONFIG_DIR)
const workspace = { id: 'adopt-workspace', name: 'Fixture', slug: 'fixture', rootPath: join(root, 'workspace'), createdAt: 1 }
writeFileSync(join(process.env.CRAFT_CONFIG_DIR, 'config.json'), JSON.stringify({ workspaces: [workspace], activeWorkspaceId: workspace.id }))
const { registerCheckpointHandlers } = await import('./checkpoints')
const handlers = new Map<string, HandlerFn>()
let calls = 0
registerCheckpointHandlers({ handle: (channel: string, handler: HandlerFn) => handlers.set(channel, handler) } as unknown as RpcServer, {
  sessionManager: {
    waitForInit: async () => {},
    getSessionSnapshot: (id: string) => id === 'imported' ? { id, workspaceId: workspace.id } : undefined,
    adoptSessionCheckpointWorktree: async () => { calls++; return { supported: true, checkpoints: [] } },
  }, windowManager: { getWorkspaceForWindow: () => workspace.id },
} as unknown as HandlerDeps)
const handler = handlers.get('sessions:adoptCheckpointWorktree')!
const context = { workspaceId: workspace.id, clientId: 'client', webContentsId: null }
afterAll(() => {
  if (previous === undefined) delete process.env.CRAFT_CONFIG_DIR; else process.env.CRAFT_CONFIG_DIR = previous
  rmSync(root, { recursive: true, force: true })
})
test('association requires the owning workspace before invoking any mutation', async () => {
  await expect(handler({ ...context, workspaceId: null }, 'imported')).rejects.toThrow('Open this session')
  await expect(handler({ ...context, workspaceId: 'unknown' }, 'imported')).rejects.toThrow('another workspace')
  await expect(handler(context, 'missing')).rejects.toThrow('Session not found')
  expect(calls).toBe(0)
  expect(await handler(context, 'imported')).toEqual({ supported: true, checkpoints: [] })
  expect(await handler({ ...context, workspaceId: null, webContentsId: 3 }, 'imported')).toEqual({ supported: true, checkpoints: [] })
  expect(calls).toBe(2)
})
