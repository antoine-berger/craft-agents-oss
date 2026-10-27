import { afterAll, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'craft-command-workflow-')))
process.env.CRAFT_CONFIG_DIR = join(root, 'config')
mkdirSync(process.env.CRAFT_CONFIG_DIR)
const { SessionManager, createManagedSession } = await import('./SessionManager')
const { loadSession, sessionPersistenceQueue } = await import('@craft-agent/shared/sessions')
const { setupI18n } = await import('@craft-agent/shared/i18n')
setupI18n()
const previousPath = process.env.PATH
mkdirSync(join(root, 'bin'))
writeFileSync(join(root, 'bin', 'gh'), '#!/bin/sh\nprintf "fixture-developer\\n"\n', { mode: 0o755 })
process.env.PATH = `${join(root, 'bin')}:${previousPath}`
const repo = join(root, 'repo'); mkdirSync(repo)
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } })
git('init', '-b', 'main'); writeFileSync(join(repo, 'code.txt'), 'fixture'); git('add', '.'); git('commit', '-m', 'Fixture')
const manager = new SessionManager()
const events: unknown[] = []
const internal = manager as any
internal.sendEvent = (event: unknown) => events.push(event)
const chat = mock(() => { throw Error('The slash command must not invoke a model') })
internal.getOrCreatePreparedAgent = mock(async () => ({ chat }))
const workspace = { id: 'fixture-workspace', name: 'Fixture', slug: 'fixture', rootPath: join(root, 'workspace'), createdAt: 1 }
mkdirSync(workspace.rootPath)
const session = createManagedSession({ id: 'fixture-chat', name: 'Workflow fixture', projectId: 'project-kept', worktree: { repositoryPath: repo, baseBranch: 'main' } }, workspace, { messagesLoaded: true })
internal.sessions.set(session.id, session)
afterAll(() => { sessionPersistenceQueue.cancel(session.id); manager.cleanup(); process.env.PATH = previousPath; rmSync(root, { recursive: true, force: true }) })
test('slash workflow first send persists its message and owned checkpoint before native dispatch without a model query', async () => {
 const command = mock(async (id: string, parsed: unknown) => {
  const stored = loadSession(workspace.rootPath, id)!
  expect(stored.projectId).toBe('project-kept')
  expect(stored.worktree?.owned?.status).toBe('ready')
  expect(stored.messages.some(message => message.type === 'user' && message.content === '/ship-plan ENG-123')).toBe(true)
  expect((await manager.listSessionCheckpoints(id)).checkpoints).toHaveLength(1)
  expect(parsed).toEqual({ kind: 'plan', ticket: 'ENG-123' })
  return { ticket: 'ENG-123', phase: 'plan', status: 'running' } as never
 })
 manager.setWorkflowCommandHandler(command)
 await manager.sendMessage(session.id, '/ship-plan ENG-123')
 expect(command).toHaveBeenCalledTimes(1)
 expect(chat).not.toHaveBeenCalled()
 expect(session.isProcessing).toBe(false)
 expect(events.some((event: any) => event.type === 'complete')).toBe(true)
 expect(readFileSync(join(repo, 'code.txt'), 'utf8')).toBe('fixture')
}, 30000)
