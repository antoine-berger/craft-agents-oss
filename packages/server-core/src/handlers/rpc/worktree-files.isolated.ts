import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RpcServer, HandlerFn } from '../../transport/types'
import type { HandlerDeps } from '../handler-deps'

const root = mkdtempSync(join(tmpdir(), 'craft-file-handler-'))
const configRoot = join(root, 'config')
const previous = process.env.CRAFT_CONFIG_DIR
process.env.CRAFT_CONFIG_DIR = configRoot
mkdirSync(configRoot)
const workspace = { id: 'files-workspace', name: 'Files test', slug: 'files-test', rootPath: join(root, 'workspace'), createdAt: 1 }
mkdirSync(workspace.rootPath)
writeFileSync(join(configRoot, 'config.json'), JSON.stringify({ workspaces: [workspace], activeWorkspaceId: workspace.id }))
const checkout = join(root, 'checkout')
execFileSync('git', ['init', '--quiet', checkout])
writeFileSync(join(checkout, 'app.ts'), 'original\n')
const { registerWorktreeFilesHandlers } = await import('./worktree-files')
const handlers = new Map<string, HandlerFn>()
let archived = false
let writeLeases = 0
const server = { handle(channel: string, handler: HandlerFn) { handlers.set(channel, handler) } } as RpcServer
const deps = { sessionManager: {
  waitForInit: async () => {},
  getSessionSnapshot: (id: string) => id === 'test-session' ? { id, workspaceId: workspace.id, workingDirectory: checkout, isArchived: archived } : undefined,
  getSessionWorkingDirectory: () => checkout,
  withSessionWorktreeWrite: async (_id: string, operation: () => Promise<unknown>) => { writeLeases++; return operation() },
} } as unknown as HandlerDeps
registerWorktreeFilesHandlers(server, deps)
const context = { workspaceId: workspace.id, clientId: 'client', webContentsId: null }
afterAll(() => { process.env.CRAFT_CONFIG_DIR = previous; if (previous === undefined) delete process.env.CRAFT_CONFIG_DIR; rmSync(root, { recursive: true, force: true }) })

test('file RPC rejects another or unknown workspace and missing sessions', async () => {
  await expect(handlers.get('worktreeFiles:list')!({ ...context, workspaceId: 'other' }, 'test-session')).rejects.toThrow('another workspace')
  await expect(handlers.get('worktreeFiles:list')!(context, 'missing')).rejects.toThrow('Session not found')
})

test('file RPC routes to the worktree and saves under the session write lease', async () => {
  const file = await handlers.get('worktreeFiles:read')!(context, 'test-session', 'app.ts')
  expect(file.content).toBe('original\n')
  const saved = await handlers.get('worktreeFiles:write')!(context, 'test-session', { path: 'app.ts', content: 'edited\n', expectedVersion: file.version })
  expect(saved.content).toBe('edited\n')
  expect(writeLeases).toBe(1)
  expect(readFileSync(join(checkout, 'app.ts'), 'utf8')).toBe('edited\n')
})

test('archived sessions can inspect files but cannot write', async () => {
  archived = true
  const file = await handlers.get('worktreeFiles:read')!(context, 'test-session', 'app.ts')
  await expect(handlers.get('worktreeFiles:write')!(context, 'test-session', { path: 'app.ts', content: 'blocked', expectedVersion: file.version })).rejects.toThrow('Unarchive')
  expect(readFileSync(join(checkout, 'app.ts'), 'utf8')).toBe('edited\n')
})
