// Run in its own Bun process: CONFIG_DIR is captured during module initialization.
import { afterAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'craft-independent-chat-')))
const originalConfigDir = process.env.CRAFT_CONFIG_DIR
const originalPath = process.env.PATH
process.env.CRAFT_CONFIG_DIR = join(root, 'config')
mkdirSync(process.env.CRAFT_CONFIG_DIR)
const workspace = { id: 'independent-fixture', name: 'Fixture', slug: 'fixture', rootPath: join(root, 'workspace'), createdAt: 1 }
mkdirSync(workspace.rootPath)
writeFileSync(join(process.env.CRAFT_CONFIG_DIR, 'config.json'), JSON.stringify({ workspaces: [workspace], activeWorkspaceId: workspace.id }))
writeFileSync(join(process.env.CRAFT_CONFIG_DIR, 'config-defaults.json'), JSON.stringify({ defaults: {}, workspaceDefaults: { permissionMode: 'allow-all' } }))
const bin = join(root, 'bin')
mkdirSync(bin)
writeFileSync(join(bin, 'gh'), '#!/bin/sh\nprintf "fixture-developer\\n"\n', { mode: 0o755 })
process.env.PATH = `${bin}:${originalPath ?? ''}`
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function createRepo(name: string) {
  const path = join(root, name)
  mkdirSync(path)
  git(path, 'init', '-b', 'main')
  writeFileSync(join(path, 'code.txt'), 'fixture\n')
  git(path, 'add', '.')
  git(path, 'commit', '-m', 'fixture')
  return path
}
const repo = createRepo('app')
const otherRepo = createRepo('other-app')
const { SessionManager, setSessionPlatform } = await import('./SessionManager')
setSessionPlatform({
  appRootPath: root, resourcesPath: join(root, 'resources'), isPackaged: false, appVersion: 'fixture', isDebugMode: false,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  imageProcessor: { async getMetadata() { return null }, async process() { throw new Error('Unexpected fixture image processing') } },
})
const { createProject, saveProjectConfig } = await import('@craft-agent/shared/projects')
const { loadSession, sessionPersistenceQueue } = await import('@craft-agent/shared/sessions')
const { setupI18n } = await import('@craft-agent/shared/i18n')
setupI18n()
const manager = new SessionManager()
manager.setEventSink(() => {})
const state = manager as any
state.startPreTurnDecisions = async () => ({ thinkingOverride: null, suggestionHint: null })
// This fixture has no connectors; preserve automatic-source synchronization itself.
state.loadSessionSources = async () => []
const backendTurns: string[] = []
const backendStarts: Array<{ id: string; cwd: string; sdkBefore?: string; owner: string; projectId?: string; parentSessionId?: string }> = []
state.getOrCreatePreparedAgent = async (managed: any) => {
  backendStarts.push({ id: managed.id, cwd: managed.workingDirectory, sdkBefore: managed.sdkSessionId, owner: managed.worktree?.owned?.ownerId, projectId: managed.projectId, parentSessionId: managed.parentSessionId })
  managed.sdkSessionId = `fixture-sdk-${managed.id}`
  managed.agent = {
    getModel: () => 'claude-sonnet-4-6', setAllSources: () => {}, getSessionId: () => managed.sdkSessionId,
    dispose: () => {}, takePendingSteers: () => [],
    getSummarizeCallback: () => undefined, setSourceServers: async () => {},
    chat: async function* () { backendTurns.push(managed.id); yield { type: 'complete' } },
  }
  return managed.agent
}
const sends: Promise<void>[] = []
const send = manager.sendMessage.bind(manager)
manager.sendMessage = (...args: Parameters<typeof manager.sendMessage>) => {
  const pending = send(...args)
  sends.push(pending)
  return pending
}
const projects = [repo, otherRepo].map(directory => {
  const project = createProject(workspace.rootPath, { name: basename(directory), workingDirectory: directory })
  saveProjectConfig(workspace.rootPath, { ...project, worktreeSettings: { enabled: true, baseBranch: 'main', cleanupOnArchive: true } })
  return project
})
const source = await manager.createSession(workspace.id, { name: 'Source', projectId: projects[0]!.id, permissionMode: 'allow-all' })
const sourceState = state.sessions.get(source.id)
await state.prepareSessionWorktree(sourceState)
sourceState.sdkSessionId = 'original-sdk-kept'
const sourcePath = sourceState.workingDirectory
const sourceOwner = sourceState.worktree.owned.ownerId

async function spawn(request: Parameters<typeof manager.spawnIndependentSession>[1]) {
  const result = await manager.spawnIndependentSession(source.id, request)
  await Promise.all(sends.splice(0))
  await manager.flushSession(result.sessionId)
  // A successful allocation alone is insufficient: the accepted turn must reach the backend.
  expect(backendTurns).toContain(result.sessionId)
  expect(state.sessions.get(result.sessionId).messages.filter((message: any) => message.role === 'error')).toEqual([])
  return { result, managed: state.sessions.get(result.sessionId), stored: loadSession(workspace.rootPath, result.sessionId)! }
}
afterAll(async () => {
  for (const managed of state.sessions.values()) { await manager.flushSession(managed.id); sessionPersistenceQueue.cancel(managed.id); managed.agent = null }
  manager.cleanup()
  if (originalConfigDir === undefined) delete process.env.CRAFT_CONFIG_DIR
  else process.env.CRAFT_CONFIG_DIR = originalConfigDir
  process.env.PATH = originalPath
  rmSync(root, { recursive: true, force: true })
})

test('agent-created chat uses the normal project and first-send pipeline with separate durable ownership and SDK', async () => {
  const { result, managed, stored } = await spawn({ prompt: 'Implement independent work', name: 'Independent fixture' })
  expect(result.sessionId).not.toBe(source.id)
  expect(managed.projectId).toBe(projects[0]!.id)
  expect(stored.projectId).toBe(projects[0]!.id)
  expect(managed.parentSessionId).toBeUndefined()
  expect(managed.branchFromSdkSessionId).toBeUndefined()
  expect(managed.workingDirectory).not.toBe(sourcePath)
  expect(managed.worktree.owned.ownerId).toBe(`${workspace.id}/${result.sessionId}`)
  expect(managed.worktree.owned.ownerId).not.toBe(sourceOwner)
  expect(managed.worktree.cleanupOnArchive).toBe(true)
  expect(backendStarts.find(start => start.id === result.sessionId)?.sdkBefore).toBeUndefined()
  expect(stored.messages.filter(message => message.type === 'user').map(message => message.content)).toEqual(['Implement independent work'])
  expect(sourceState.sdkSessionId).toBe('original-sdk-kept')
  expect(sourceState.workingDirectory).toBe(sourcePath)
  expect(sourceState.worktree.owned.ownerId).toBe(sourceOwner)
}, 30_000)

test('explicit other project uses that project repository and preserves current chat', async () => {
  const { managed, stored } = await spawn({ prompt: 'Work on second project', name: 'Other fixture', projectId: projects[1]!.id })
  expect(stored.projectId).toBe(projects[1]!.id)
  expect(managed.worktree.repositoryPath).toBe(otherRepo)
  expect(git(managed.workingDirectory, 'rev-parse', '--git-common-dir')).toContain('other-app')
  expect(sourceState.projectId).toBe(projects[0]!.id)
  expect(sourceState.sdkSessionId).toBe('original-sdk-kept')
}, 30_000)

test('null project and explicit repository produce an ungrouped, independently owned chat', async () => {
  const { managed, stored } = await spawn({ prompt: 'Ungrouped task', name: 'Ungrouped fixture', projectId: null, repository: { kind: 'local', gitDir: join(repo, '.git'), name: 'app' } })
  expect(stored.projectId).toBeUndefined()
  expect(managed.parentSessionId).toBeUndefined()
  expect(managed.worktree.repositoryPath).toBe(repo)
  expect(managed.worktree.owned.path).not.toBe(sourceState.worktree.owned.path)
}, 30_000)

test('pending task source is not repeated in a new chat', async () => {
  const ready = sourceState.worktree
  sourceState.worktree = { repositoryPath: '', pendingRepository: { kind: 'local', gitDir: join(repo, '.git'), name: 'app', start: { kind: 'github-issue', number: 987 } } }
  try {
    const { managed } = await spawn({ prompt: 'A different task', name: 'Different fixture' })
    expect(managed.worktree.resolvedStart?.context).toBeUndefined()
    expect(managed.worktree.owned.branch).toContain('a-different-task')
    expect(sourceState.worktree.pendingRepository.start.number).toBe(987)
  } finally { sourceState.worktree = ready }
}, 30_000)
