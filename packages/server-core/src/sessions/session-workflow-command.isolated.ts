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
const { TestAgent, createMockBackendConfig } = await import('../../../shared/src/agent/__tests__/test-utils')
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
const workspace = { id: 'fixture-workspace', name: 'Fixture', slug: 'fixture', rootPath: join(root, 'workspace'), createdAt: 1 }
mkdirSync(workspace.rootPath)
mkdirSync(join(workspace.rootPath, 'skills', 'ship-plan'), { recursive: true })
writeFileSync(join(workspace.rootPath, 'skills', 'ship-plan', 'SKILL.md'), '---\nname: ship-plan\ndescription: Plan in this chat using native subagents.\n---\nUse the current chat and worktree.\n')
const agent = new TestAgent(createMockBackendConfig({ workspace }))
internal.getOrCreatePreparedAgent = mock(async () => agent)
const session = createManagedSession({ id: 'fixture-chat', name: 'Workflow fixture', projectId: 'project-kept', worktree: { repositoryPath: repo, baseBranch: 'main' } }, workspace, { messagesLoaded: true })
internal.sessions.set(session.id, session)
afterAll(() => { sessionPersistenceQueue.cancel(session.id); manager.cleanup(); process.env.PATH = previousPath; rmSync(root, { recursive: true, force: true }) })
test('slash skill first send follows the normal chat path, preserving its project and owned checkpoint without creating sessions', async () => {
 await manager.sendMessage(session.id, '/ship-plan ENG-123')
 await sessionPersistenceQueue.flush(session.id)
 const stored = loadSession(workspace.rootPath, session.id)!
  expect(stored.projectId).toBe('project-kept')
  expect(stored.worktree?.owned?.status).toBe('ready')
  expect(stored.messages.some(message => message.type === 'user' && message.content === '/ship-plan ENG-123')).toBe(true)
 expect((await manager.listSessionCheckpoints(session.id)).checkpoints).toHaveLength(1)
 expect(agent.chatCalls).toHaveLength(1)
 expect(agent.chatCalls[0]!.message).toContain(join(workspace.rootPath, 'skills', 'ship-plan', 'SKILL.md'))
 expect(agent.chatCalls[0]!.message).toContain('ENG-123')
 expect(internal.sessions.size).toBe(1)
 expect(stored.messages.some(message => message.content.startsWith('Ship ENG-123:'))).toBe(false)
 expect(session.isProcessing).toBe(false)
 expect(events.some((event: any) => event.type === 'complete')).toBe(true)
 expect(readFileSync(join(repo, 'code.txt'), 'utf8')).toBe('fixture')
}, 30000)
