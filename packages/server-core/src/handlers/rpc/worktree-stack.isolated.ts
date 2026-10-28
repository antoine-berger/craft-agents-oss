import { afterAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RpcServer, HandlerFn } from '../../transport/types'
import type { HandlerDeps } from '../handler-deps'

const root = mkdtempSync(join(tmpdir(), 'craft-stack-handler-'))
const previousConfig = process.env.CRAFT_CONFIG_DIR, previousPath = process.env.PATH
process.env.CRAFT_CONFIG_DIR = join(root, 'config')
mkdirSync(process.env.CRAFT_CONFIG_DIR)
const workspace = { id: 'stack-workspace', name: 'Fixture', slug: 'stack', rootPath: join(root, 'workspace'), createdAt: 1 }
mkdirSync(workspace.rootPath)
writeFileSync(join(process.env.CRAFT_CONFIG_DIR, 'config.json'), JSON.stringify({ workspaces: [workspace], activeWorkspaceId: workspace.id }))
const bin = join(root, 'bin'); mkdirSync(bin)
writeFileSync(join(bin, 'gh'), '#!/bin/sh\nprintf "fixture-developer\\n"\n', { mode: 0o755 })
process.env.PATH = `${bin}:${previousPath ?? ''}`
const repo = join(root, 'repo'), parentPath = join(root, 'parent')
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
execFileSync('git', ['init', '-q', '-b', 'main', repo])
git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
writeFileSync(join(repo, 'base.txt'), 'initial'); git('add', '.'); git('commit', '-qm', 'Initial')
git('worktree', 'add', '-qb', 'fixture/parent', parentPath, 'main')
const { SessionManager, createManagedSession } = await import('../../sessions/SessionManager')
const { registerWorktreeStackHandlers } = await import('./worktree-stack')
const manager = new SessionManager()
manager.setEventSink(() => {})
const internal = manager as any
const parent = createManagedSession({ id: 'parent', name: 'Parent', workingDirectory: parentPath }, workspace as any, { messagesLoaded: true })
const child = createManagedSession({ id: 'child', name: 'Child', worktree: {
  repositoryPath: repo, pendingRepository: { kind: 'local', gitDir: join(repo, '.git'), name: 'repo', start: { kind: 'branch', branch: 'fixture/parent', copy: true } },
} }, workspace as any, { messagesLoaded: true })
internal.sessions.set(parent.id, parent); internal.sessions.set(child.id, child)
const handlers = new Map<string, HandlerFn>()
registerWorktreeStackHandlers({ handle(channel: string, fn: HandlerFn) { handlers.set(channel, fn) } } as RpcServer,
  { sessionManager: manager } as unknown as HandlerDeps)
const context = { workspaceId: workspace.id, clientId: 'fixture', webContentsId: null }
afterAll(async () => {
  await manager.flushSession(child.id)
  manager.cleanup()
  if (previousConfig === undefined) delete process.env.CRAFT_CONFIG_DIR; else process.env.CRAFT_CONFIG_DIR = previousConfig
  if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath
  rmSync(root, { recursive: true, force: true })
})

test('normal worktree preparation persists its exact stack parent before creating an agent', async () => {
  await internal.withWorktreeLock(child, () => internal.prepareSessionWorktree(child))
  expect(child.worktree?.stackParent).toMatchObject({ parentSessionId: 'parent', branch: 'fixture/parent', association: 'verified' })
  expect(child.worktree?.stackParent?.baseCommit).toBe(child.worktree?.owned?.baseCommit)
  expect(child.agent).toBeNull()
  const stored = JSON.parse(readFileSync(join(workspace.rootPath, 'sessions', 'child', 'session.jsonl'), 'utf8').split('\n')[0]!)
  expect(stored.worktree.stackParent).toEqual(child.worktree?.stackParent)
})

test('stack snapshots are workspace-scoped and do not issue prompts or Git writes', async () => {
  internal.initGate.markReady()
  const before = git('show-ref')
  const snapshot = await handlers.get('worktreeStack:get')!(context, child.id)
  expect(snapshot.parent?.session?.sessionId).toBe(parent.id)
  expect(snapshot.parent?.state).toBe('up-to-date')
  await expect(handlers.get('worktreeStack:get')!({ ...context, workspaceId: 'other' }, child.id)).rejects.toThrow('workspace')
  await expect(handlers.get('worktreeStack:get')!(context, 'missing')).rejects.toThrow('Session not found')
  expect(child.agent).toBeNull()
  expect(git('show-ref')).toBe(before)
})
