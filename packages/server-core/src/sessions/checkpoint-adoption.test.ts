import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionFilePath } from '@craft-agent/shared/sessions/storage'
import { SessionManager, createManagedSession } from './SessionManager'

let root: string, repo: string, manager: SessionManager, internal: any
let session: ReturnType<typeof createManagedSession>
const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'craft-checkpoint-association-')))
  repo = join(root, 'repo')
  git('init', '--quiet', '-b', 'main', repo)
  writeFileSync(join(repo, 'code.txt'), 'original\n')
  git('-C', repo, 'add', '.')
  git('-C', repo, 'commit', '--quiet', '-m', 'Initial')
  manager = new SessionManager(); internal = manager as any
  manager.setEventSink(() => {})
  internal.getBrowserPaneManagerForSession = () => null
  session = createManagedSession({ id: 'imported', name: 'Retained title', workingDirectory: repo,
    sdkCwd: join(root, 'sdk-transcript-location'), sdkSessionId: 'existing-sdk-id',
    importedFrom: { provider: 'conductor', sourceId: 'source', sessionId: 'original', fingerprint: 'fixture', importedAt: 1 },
  } as any, { id: 'fixture', name: 'Fixture', rootPath: join(root, 'workspace'), createdAt: 1 } as any, { messagesLoaded: true })
  session.messages.push({ id: 'retained-message', role: 'user', content: 'Imported history', timestamp: 1 })
  internal.sessions.set(session.id, session)
})
afterEach(async () => {
  await manager.flushSession(session.id)
  manager.cleanup()
  rmSync(root, { recursive: true, force: true })
})

test('explicit imported association preserves SDK cwd, messages and checkout, persists metadata and creates no old checkpoints', async () => {
  const sdkCwd = session.sdkCwd
  const result = await manager.adoptSessionCheckpointWorktree(session.id)
  expect(result.supported).toBe(true)
  expect(result.checkpoints).toEqual([])
  expect(session.worktree?.owned?.adopted).toBe(true)
  expect(session.worktree?.cleanupOnArchive).toBe(false)
  expect(session.workingDirectory).toBe(repo)
  expect(session.sdkCwd).toBe(sdkCwd)
  expect(session.sdkSessionId).toBe('existing-sdk-id')
  expect(session.messages.map(message => message.content)).toEqual(['Imported history'])
  const stored = JSON.parse(readFileSync(getSessionFilePath(session.workspace.rootPath, session.id), 'utf8').split('\n')[0]!)
  expect(stored.worktree.owned.adopted).toBe(true)
  expect(stored.sdkCwd).toBe(sdkCwd)
  await internal.prepareSessionWorktree(session)
  expect(session.sdkCwd).toBe(sdkCwd)
  expect(git('-C', repo, 'branch', '--show-current')).toBe('main')
  await manager.archiveSession(session.id)
  expect(existsSync(repo)).toBe(true)
  expect(readFileSync(join(repo, 'code.txt'), 'utf8')).toBe('original\n')
})

test('active agent and archived chats cannot associate a checkout', async () => {
  session.isProcessing = true
  await expect(manager.adoptSessionCheckpointWorktree(session.id)).rejects.toThrow('Stop running')
  expect(session.worktree?.owned).toBeUndefined()
  expect(existsSync(join(repo, '.git', 'craft-session-worktrees'))).toBe(false)
  session.isProcessing = false
  session.isArchived = true
  await expect(manager.adoptSessionCheckpointWorktree(session.id)).rejects.toThrow('archived')
})

test('a terminal or agent in a second chat sharing the checkout must stop before association', async () => {
  const sibling = createManagedSession({ id: 'sibling', workingDirectory: repo }, session.workspace, { messagesLoaded: true })
  internal.sessions.set(sibling.id, sibling)
  let running = true
  manager.registerWorktreeResource({ hasRunningSession: id => running && id === sibling.id, stopSession() { running = false }, dispose() {} })
  await expect(manager.adoptSessionCheckpointWorktree(session.id)).rejects.toThrow('Stop running')
  running = false
  sibling.isProcessing = true
  await expect(manager.adoptSessionCheckpointWorktree(session.id)).rejects.toThrow('Stop running')
  sibling.isProcessing = false
  expect((await manager.adoptSessionCheckpointWorktree(session.id)).supported).toBe(true)
})
