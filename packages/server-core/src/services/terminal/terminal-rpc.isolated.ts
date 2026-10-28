import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { HandlerDeps } from '../../handlers/handler-deps'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'
import type { PtyProcess } from './session-terminal'

const root = mkdtempSync(join(tmpdir(), 'craft-terminal-rpc-'))
const previousConfig = process.env.CRAFT_CONFIG_DIR
process.env.CRAFT_CONFIG_DIR = join(root, 'config')
mkdirSync(process.env.CRAFT_CONFIG_DIR)
const workspaces = [{ id: 'one', name: 'One', rootPath: join(root, 'one'), createdAt: 1 }, { id: 'two', name: 'Two', rootPath: join(root, 'two'), createdAt: 1 }]
writeFileSync(join(process.env.CRAFT_CONFIG_DIR, 'config.json'), JSON.stringify({ workspaces, activeWorkspaceId: 'one' }))
const { registerTerminalHandlers, disposeSessionTerminals } = await import('../../handlers/rpc/terminal')
afterAll(async () => {
  await disposeSessionTerminals()
  if (previousConfig === undefined) delete process.env.CRAFT_CONFIG_DIR; else process.env.CRAFT_CONFIG_DIR = previousConfig
  rmSync(root, { recursive: true, force: true })
})

const handlers = new Map<string, HandlerFn>()
const sessions = new Map([['a', { id: 'a', workspaceId: 'one', isArchived: false }], ['b', { id: 'b', workspaceId: 'two', isArchived: false }]])
let guarded = 0
let restoring = false
let disposedResource: { dispose(): Promise<void> | void } | undefined
const exits = new Set<(event: { exitCode: number }) => void>()
const fakeProcess: PtyProcess = { write() {}, resize() {}, kill() { for (const callback of exits) callback({ exitCode: 0 }) }, onData() { return { dispose() {} } }, onExit(listener) { exits.add(listener); return { dispose() { exits.delete(listener) } } } }
const deps = {
  sessionManager: {
    getSessionSnapshot: (id: string) => sessions.get(id) ?? null,
    registerWorktreeResource(resource: { dispose(): Promise<void> | void }) { disposedResource = resource; return () => {} },
    async withSessionWorktreeWrite<T>(_id: string, operation: () => Promise<T>) { if (restoring) throw new Error('restoring'); guarded++; return operation() },
  },
  windowManager: { getWorkspaceForWindow: () => 'one' },
} as unknown as HandlerDeps
const server = { handle(channel: string, handler: HandlerFn) { handlers.set(channel, handler) }, push() {} } as unknown as RpcServer
const ctx: RequestContext = { clientId: 'client', workspaceId: 'one', webContentsId: null }
function invoke(channel: string, context: RequestContext, ...args: unknown[]) { return Promise.resolve().then(() => handlers.get(channel)!(context, ...args)) }

test('terminal RPC binds authorization to the caller workspace and serializes open against restore', async () => {
  registerTerminalHandlers(server, deps, { resolveSession: async id => ({ workspaceId: sessions.get(id)!.workspaceId, directory: '/fixture' }), spawn: async () => fakeProcess })
  await expect(invoke('terminal:open', ctx, 'b', { cols: 80, rows: 24 })).rejects.toThrow('workspace')
  await expect(invoke('terminal:open', { ...ctx, workspaceId: 'missing' }, 'a', { cols: 80, rows: 24 })).rejects.toThrow('workspace')
  await expect(invoke('terminal:open', { ...ctx, workspaceId: null }, 'a', { cols: 80, rows: 24 })).rejects.toThrow('workspace')
  restoring = true
  await expect(invoke('terminal:open', ctx, 'a', { cols: 80, rows: 24 })).rejects.toThrow('restoring')
  restoring = false
  const opened = await invoke('terminal:open', ctx, 'a', { cols: 80, rows: 24 })
  expect(guarded).toBe(1)
  await expect(invoke('terminal:write', { ...ctx, clientId: 'stranger' }, 'a', opened.id, 'ls\r')).rejects.toThrow('Open this session')
  sessions.get('a')!.isArchived = true
  await expect(invoke('terminal:write', ctx, 'a', opened.id, 'ls\r')).rejects.toThrow('Archived')
  await disposedResource?.dispose()
  // Handler module singleton is released by the SessionManager lifecycle cleanup.
  registerTerminalHandlers(server, deps, { resolveSession: async () => ({ workspaceId: 'one', directory: '/fixture' }), spawn: async () => fakeProcess })
  await disposeSessionTerminals()
})
