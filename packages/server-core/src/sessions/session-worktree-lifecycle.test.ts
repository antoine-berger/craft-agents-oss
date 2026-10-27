import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CreateSessionOptions } from '@craft-agent/shared/protocol'
import { setupI18n } from '@craft-agent/shared/i18n'
import { getSessionFilePath, loadSession, readSessionHeader, sessionPersistenceQueue } from '@craft-agent/shared/sessions'
import { createManagedSession, SessionManager } from './SessionManager.ts'
import { resolveSessionWorktreePolicy, defaultSessionWorktreePolicy } from './session-worktree.ts'

type ManagedSession = ReturnType<typeof createManagedSession>
type Agent = NonNullable<ManagedSession['agent']>
type LifecycleHarness = {
  sessions: Map<string, ManagedSession>
  worktreeLocks: Map<string, Promise<void>>
  keepBackgroundTasksAlive: boolean
  sendEvent: ReturnType<typeof mock>
  getOrCreatePreparedAgent: ReturnType<typeof mock>
  getOrCreateAgent(managed: ManagedSession): Promise<Agent>
  cleanupSessionWorktree(managed: ManagedSession): Promise<void>
  persistSession(managed: ManagedSession): void
  flushSession(sessionId: string): Promise<void>
  prepareNewSessionWorktree(workspaceId: string, sessionId: string, repositoryPath: string): Promise<{ path: string; branch: string }>
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Session Worktree Test', GIT_AUTHOR_EMAIL: 'worktree@example.invalid',
  GIT_COMMITTER_NAME: 'Session Worktree Test', GIT_COMMITTER_EMAIL: 'worktree@example.invalid',
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'],
}).trim()

let root: string
let repository: string
let workspace: ManagedSession['workspace']
const sessionIds = new Set<string>()

beforeAll(() => { setupI18n() })

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'session-worktree-lifecycle-')))
  repository = join(root, 'repo')
  mkdirSync(repository)
  git(repository, 'init', '-b', 'main')
  writeFileSync(join(repository, 'code.txt'), 'main checkout\n')
  writeFileSync(join(repository, '.gitignore'), '.env\nnode_modules/\n')
  git(repository, 'add', '.')
  git(repository, 'commit', '-m', 'Initial commit')
  workspace = { id: randomUUID(), slug: 'test', name: 'Test', rootPath: join(root, 'workspace'), createdAt: 1 }
  mkdirSync(workspace.rootPath)
})

afterEach(async () => {
  for (const id of sessionIds) {
    await sessionPersistenceQueue.flush(id)
    sessionPersistenceQueue.cancel(id)
  }
  sessionIds.clear()
  rmSync(root, { recursive: true, force: true })
})

/** Keep persistence, Git operations, runtime disposal and locks real; replace only backend construction. */
function harness() {
  const manager = Object.create(SessionManager.prototype) as LifecycleHarness
  manager.sessions = new Map()
  manager.worktreeLocks = new Map()
  manager.keepBackgroundTasksAlive = true
  manager.sendEvent = mock(() => {})
  const backendStarts: Array<{ sessionId: string; cwd?: string; sdkCwd?: string; persisted: ReturnType<typeof loadSession> }> = []
  manager.getOrCreatePreparedAgent = mock(async (managed: ManagedSession) => {
    backendStarts.push({
      sessionId: managed.id, cwd: managed.workingDirectory, sdkCwd: managed.sdkCwd,
      persisted: loadSession(managed.workspace.rootPath, managed.id),
    })
    managed.agent ??= {
      disposeForRestart: mock(async () => {}),
      takePendingSteers: () => [],
    } as unknown as Agent
    return managed.agent
  })

  const createChat = (overrides: Partial<ManagedSession> = {}) => {
    const id = randomUUID()
    const managed = createManagedSession({
      id, workingDirectory: repository, sdkCwd: repository, llmConnection: 'claude-account-a',
      worktree: { repositoryPath: repository, baseBranch: 'main', cleanupOnArchive: true },
    }, workspace, {
      messagesLoaded: true,
      messages: [{ id: `${id}-user`, role: 'user', content: 'Implement this feature', timestamp: 1 }],
      ...overrides,
    })
    manager.sessions.set(managed.id, managed)
    sessionIds.add(managed.id)
    return managed
  }

  const restoreChat = (id: string) => {
    const stored = loadSession(workspace.rootPath, id)
    expect(stored).not.toBeNull()
    const managed = createManagedSession(stored as unknown as Parameters<typeof createManagedSession>[0], workspace)
    manager.sessions.set(managed.id, managed)
    sessionIds.add(managed.id)
    return managed
  }

  return { manager, backendStarts, createChat, restoreChat }
}

function worktreeCount(): number {
  return git(repository, 'worktree', 'list', '--porcelain').match(/^worktree /gm)?.length ?? 0
}

/** Exercise the public send/delete paths with the actual initialized manager fields. */
function sendHarness() {
  const manager = new SessionManager()
  const internals = manager as unknown as LifecycleHarness
  const events: Array<{ type: string; sessionId?: string; error?: string }> = []
  internals.sendEvent = mock((event: typeof events[number]) => { events.push(event) })
  internals.getOrCreatePreparedAgent = mock(async () => { throw new Error('Backend must not start in this test') })
  const managed = createManagedSession({
    id: randomUUID(), name: 'Worktree failure regression', workingDirectory: repository, sdkCwd: repository,
    worktree: { repositoryPath: repository, baseBranch: 'main', cleanupOnArchive: true },
  }, workspace, { messagesLoaded: true })
  internals.sessions.set(managed.id, managed)
  sessionIds.add(managed.id)
  return { manager, internals, managed, events }
}

describe('SessionManager worktree lifecycle', () => {
  it('keeps a repository choice as metadata until the first backend starts', async () => {
    const { manager, createChat } = harness()
    const chat = createChat({ messages: [], worktree: { repositoryPath: '', needsRepository: false,
      pendingRepository: { kind: 'local', gitDir: join(repository, '.git'), name: 'repo' } } })
    manager.persistSession(chat)
    await manager.flushSession(chat.id)
    expect(git(repository, 'worktree', 'list', '--porcelain').split('worktree ').length - 1).toBe(1)
    expect(chat.worktree?.owned).toBeUndefined()
    await manager.getOrCreateAgent(chat)
    expect(chat.worktree?.owned?.status).toBe('ready')
    expect(chat.worktree?.pendingRepository).toBeUndefined()
    expect(chat.workingDirectory).not.toBe(repository)
    expect(git(repository, 'worktree', 'list', '--porcelain').split('worktree ').length - 1).toBe(2)
  })

  it('creates distinct durable worktrees for two repository selections and resumes the same checkout after reload', async () => {
    const { manager, createChat, restoreChat } = harness()
    const a = createChat({ messages: [], worktree: { repositoryPath: root, needsRepository: true } })
    const b = createChat({ messages: [], worktree: { repositoryPath: root, needsRepository: true } })
    const first = await manager.prepareNewSessionWorktree(workspace.id, a.id, repository)
    const second = await manager.prepareNewSessionWorktree(workspace.id, b.id, repository)
    expect(first.path).not.toBe(second.path)
    expect(first.branch).not.toBe(second.branch)
    expect(first.path).not.toBe(repository)
    expect(readFileSync(join(repository, 'code.txt'), 'utf8')).toBe('main checkout\n')
    expect(restoreChat(a.id).worktree?.owned?.path).toBe(first.path)
    expect(await manager.prepareNewSessionWorktree(workspace.id, a.id, repository)).toEqual(first)
    await expect(manager.prepareNewSessionWorktree(workspace.id, a.id, root)).rejects.toThrow('Start a new chat')
    await expect(manager.prepareNewSessionWorktree('another-workspace', b.id, repository)).rejects.toThrow('Session not found')
  })

  it('defaults independent repository sessions to worktrees while non-repository folders require selection', async () => {
    expect(await defaultSessionWorktreePolicy(repository)).toMatchObject({ repositoryPath: repository, needsRepository: false })
    expect(await defaultSessionWorktreePolicy(root)).toMatchObject({ repositoryPath: root, needsRepository: true })
    expect(await defaultSessionWorktreePolicy(repository, { workingDirectory: repository })).toMatchObject({ repositoryPath: repository })
    for (const options of [{ hidden: true }, { parentSessionId: 'parent' }, { systemPromptPreset: 'mini' }, { worktree: 'none' as const }]) {
      expect(await defaultSessionWorktreePolicy(repository, options)).toBeUndefined()
    }
  })
  it('starts the first chat only after its isolated cwd and ownership are durable', async () => {
    const { manager, createChat, backendStarts } = harness()
    const managed = createChat()
    await manager.getOrCreateAgent(managed)
    const owned = managed.worktree!.owned!

    expect(owned.ownerId).toBe(`${workspace.id}/${managed.id}`)
    expect(owned.status).toBe('ready')
    expect(owned.path).not.toBe(repository)
    expect(git(owned.path, 'symbolic-ref', '--short', 'HEAD')).toBe(owned.branch)
    expect(backendStarts).toHaveLength(1)
    expect(backendStarts[0]?.cwd).toBe(owned.path)
    expect(backendStarts[0]?.sdkCwd).toBe(owned.path)
    expect(backendStarts[0]?.persisted?.worktree?.owned).toEqual(owned)
    expect(backendStarts[0]?.persisted?.workingDirectory).toBe(owned.path)
    expect(backendStarts[0]?.persisted?.sdkCwd).toBe(owned.path)
    expect(backendStarts[0]?.persisted?.llmConnection).toBe('claude-account-a')
    expect(backendStarts[0]?.persisted?.messages[0]?.content).toBe('Implement this feature')
    expect(manager.sendEvent).toHaveBeenCalledWith({
      type: 'working_directory_changed', sessionId: managed.id, workingDirectory: owned.path,
    }, workspace.id)
    expect(git(repository, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(git(repository, 'status', '--porcelain')).toBe('')
  })

  it('reloads the same path, branch, account and SDK session from JSONL after a restart', async () => {
    const first = harness()
    const original = first.createChat()
    await first.manager.getOrCreateAgent(original)
    original.sdkSessionId = 'sdk-resume-this-conversation'
    first.manager.persistSession(original)
    await first.manager.flushSession(original.id)
    const savedOwned = structuredClone(original.worktree!.owned!)
    writeFileSync(join(savedOwned.path, 'in-progress.txt'), 'Uncommitted work survives restart')

    const second = harness()
    const restored = second.restoreChat(original.id)
    expect(restored.messagesLoaded).toBe(false)
    await second.manager.getOrCreateAgent(restored)

    expect(restored.worktree?.owned).toEqual(savedOwned)
    expect(restored.sdkSessionId).toBe('sdk-resume-this-conversation')
    expect(restored.llmConnection).toBe('claude-account-a')
    expect(second.backendStarts[0]?.sdkCwd).toBe(savedOwned.path)
    expect(restored.messages[0]?.content).toBe('Implement this feature')
    expect(readFileSync(join(savedOwned.path, 'in-progress.txt'), 'utf8')).toBe('Uncommitted work survives restart')
    expect(worktreeCount()).toBe(2)
  })

  it('keeps a monorepo project cwd through startup, restart and archive restoration', async () => {
    const projectDirectory = join(repository, 'packages', 'api')
    mkdirSync(projectDirectory, { recursive: true })
    writeFileSync(join(projectDirectory, 'api.txt'), 'API project\n')
    git(repository, 'add', '.')
    git(repository, 'commit', '-m', 'Add API project')
    const first = harness()
    const original = first.createChat({
      workingDirectory: projectDirectory,
      sdkCwd: projectDirectory,
      worktree: { repositoryPath: projectDirectory, baseBranch: 'main', cleanupOnArchive: true },
    })
    await first.manager.getOrCreateAgent(original)
    const owned = original.worktree!.owned!
    const expectedCwd = join(owned.path, 'packages', 'api')

    expect(first.backendStarts[0]?.cwd).toBe(expectedCwd)
    expect(first.backendStarts[0]?.sdkCwd).toBe(expectedCwd)
    expect(first.backendStarts[0]?.persisted?.workingDirectory).toBe(expectedCwd)
    expect(first.backendStarts[0]?.persisted?.sdkCwd).toBe(expectedCwd)
    expect(first.manager.sendEvent).toHaveBeenCalledWith({
      type: 'working_directory_changed', sessionId: original.id, workingDirectory: expectedCwd,
    }, workspace.id)
    original.sdkSessionId = 'sdk-project-subdirectory'
    first.manager.persistSession(original)
    await first.manager.flushSession(original.id)

    // Reopening must use the saved relative cwd, even if the source project folder disappears.
    rmSync(projectDirectory, { recursive: true })
    const second = harness()
    const restored = second.restoreChat(original.id)
    await second.manager.getOrCreateAgent(restored)
    expect(second.backendStarts[0]?.sdkCwd).toBe(expectedCwd)
    restored.isArchived = true
    await second.manager.cleanupSessionWorktree(restored)
    expect(existsSync(owned.path)).toBe(false)

    const third = harness()
    const reopened = third.restoreChat(original.id)
    reopened.isArchived = false
    await third.manager.getOrCreateAgent(reopened)
    expect(third.backendStarts[0]?.cwd).toBe(expectedCwd)
    expect(third.backendStarts[0]?.sdkCwd).toBe(expectedCwd)
    expect(reopened.sdkSessionId).toBe('sdk-project-subdirectory')
    expect(reopened.worktree?.owned?.path).toBe(owned.path)
    expect(readFileSync(join(expectedCwd, 'api.txt'), 'utf8')).toBe('API project\n')
    expect(worktreeCount()).toBe(2)
  })

  it('isolates two simultaneous chats in the same repo without changing their selected accounts', async () => {
    const { manager, createChat } = harness()
    const first = createChat({ llmConnection: 'claude-account-a' })
    const second = createChat({ llmConnection: 'claude-account-b' })
    await Promise.all([manager.getOrCreateAgent(first), manager.getOrCreateAgent(second)])
    const firstOwned = first.worktree!.owned!
    const secondOwned = second.worktree!.owned!
    expect(firstOwned.path).not.toBe(secondOwned.path)
    expect(firstOwned.branch).not.toBe(secondOwned.branch)
    writeFileSync(join(firstOwned.path, 'code.txt'), 'Only first chat changes this')
    expect(readFileSync(join(secondOwned.path, 'code.txt'), 'utf8')).toBe('main checkout\n')
    expect(readFileSync(join(repository, 'code.txt'), 'utf8')).toBe('main checkout\n')
    expect(loadSession(workspace.rootPath, first.id)?.llmConnection).toBe('claude-account-a')
    expect(loadSession(workspace.rootPath, second.id)?.llmConnection).toBe('claude-account-b')
    expect(worktreeCount()).toBe(3)
  })

  it('serializes two starts of one chat without allocating another checkout', async () => {
    const { manager, createChat } = harness()
    const managed = createChat()
    const agents = await Promise.all([manager.getOrCreateAgent(managed), manager.getOrCreateAgent(managed)])
    expect(agents[0]).toBe(agents[1])
    expect(worktreeCount()).toBe(2)
    expect(manager.worktreeLocks.size).toBe(0)
  })

  it('disposes the runtime, removes a clean archived checkout and restores the committed branch on reopen', async () => {
    const first = harness()
    const managed = first.createChat()
    await first.manager.getOrCreateAgent(managed)
    const owned = structuredClone(managed.worktree!.owned!)
    writeFileSync(join(owned.path, 'feature.txt'), 'Committed session work')
    git(owned.path, 'add', '.')
    git(owned.path, 'commit', '-m', 'Implement feature')
    const commit = git(owned.path, 'rev-parse', 'HEAD')
    const disposed = Promise.withResolvers<void>()
    const disposalStarted = Promise.withResolvers<void>()
    const disposeForRestart = mock(async () => {
      disposalStarted.resolve()
      await disposed.promise
    })
    managed.agent!.disposeForRestart = disposeForRestart
    managed.sdkSessionId = 'sdk-session-to-reopen'
    managed.isArchived = true
    const cleanup = first.manager.cleanupSessionWorktree(managed)
    await disposalStarted.promise
    expect(existsSync(owned.path)).toBe(true)
    disposed.resolve()
    await cleanup

    expect(disposeForRestart).toHaveBeenCalledTimes(1)
    expect(managed.agent).toBeNull()
    expect(existsSync(owned.path)).toBe(false)
    expect(loadSession(workspace.rootPath, managed.id)?.worktree?.owned?.status).toBe('removed')
    expect(git(repository, 'rev-parse', `refs/heads/${owned.branch}`)).toBe(commit)

    const second = harness()
    const restored = second.restoreChat(managed.id)
    restored.isArchived = false
    await second.manager.getOrCreateAgent(restored)
    expect(restored.worktree?.owned?.path).toBe(owned.path)
    expect(restored.worktree?.owned?.branch).toBe(owned.branch)
    expect(restored.worktree?.owned?.status).toBe('ready')
    expect(restored.sdkSessionId).toBe('sdk-session-to-reopen')
    expect(git(owned.path, 'rev-parse', 'HEAD')).toBe(commit)
    expect(readFileSync(join(owned.path, 'feature.txt'), 'utf8')).toBe('Committed session work')
    expect(second.backendStarts[0]?.sdkCwd).toBe(owned.path)
  })

  for (const filename of ['code.txt', 'untracked.txt', '.env']) {
    it(`keeps the archived checkout containing local ${filename}`, async () => {
      const { manager, createChat } = harness()
      const managed = createChat()
      await manager.getOrCreateAgent(managed)
      const path = managed.worktree!.owned!.path
      writeFileSync(join(path, filename), 'Do not lose this local file')
      managed.isArchived = true
      await manager.cleanupSessionWorktree(managed)
      expect(readFileSync(join(path, filename), 'utf8')).toBe('Do not lose this local file')
      expect(managed.worktree?.owned?.status).toBe('ready')
      expect(worktreeCount()).toBe(2)
    })
  }

  for (const sharedField of ['workingDirectory', 'sdkCwd', 'branchFromSdkCwd'] as const) {
    it(`keeps a checkout still referenced by another session's ${sharedField}`, async () => {
      const { manager, createChat } = harness()
      const managed = createChat()
      await manager.getOrCreateAgent(managed)
      const path = managed.worktree!.owned!.path
      createChat({ worktree: undefined, [sharedField]: path })
      const agent = managed.agent
      managed.isArchived = true
      await manager.cleanupSessionWorktree(managed)
      expect(existsSync(path)).toBe(true)
      expect(managed.agent).toBe(agent)
      expect(agent!.disposeForRestart).not.toHaveBeenCalled()
    })
  }

  it('does not remove the checkout when the chat is reopened while runtime disposal is pending', async () => {
    const { manager, createChat } = harness()
    const managed = createChat()
    await manager.getOrCreateAgent(managed)
    const started = Promise.withResolvers<void>()
    const proceed = Promise.withResolvers<void>()
    managed.agent!.disposeForRestart = async () => { started.resolve(); await proceed.promise }
    managed.isArchived = true
    const cleanup = manager.cleanupSessionWorktree(managed)
    await started.promise
    managed.isArchived = false
    proceed.resolve()
    await cleanup
    expect(existsSync(managed.worktree!.owned!.path)).toBe(true)
    expect(managed.worktree?.owned?.status).toBe('ready')
  })

  it('keeps a checkout used by an active chat in a monorepo subdirectory', async () => {
    const { manager, createChat } = harness()
    const managed = createChat()
    await manager.getOrCreateAgent(managed)
    const path = managed.worktree!.owned!.path
    const subdirectory = join(path, 'packages')
    mkdirSync(subdirectory)
    createChat({ worktree: undefined, workingDirectory: subdirectory, sdkCwd: subdirectory, isProcessing: true })
    const agent = managed.agent
    managed.isArchived = true
    await manager.cleanupSessionWorktree(managed)
    expect(existsSync(subdirectory)).toBe(true)
    expect(managed.agent).toBe(agent)
    expect(agent!.disposeForRestart).not.toHaveBeenCalled()
  })

  it('keeps the checkout if the runtime cannot be stopped safely', async () => {
    const { manager, createChat } = harness()
    const managed = createChat()
    await manager.getOrCreateAgent(managed)
    const path = managed.worktree!.owned!.path
    managed.agent!.disposeForRestart = async () => { throw new Error('process still running') }
    managed.isArchived = true
    await manager.cleanupSessionWorktree(managed)
    // A second cleanup must not mistake the cleared runtime handle for a confirmed teardown.
    await manager.cleanupSessionWorktree(managed)
    expect(existsSync(path)).toBe(true)
    expect(managed.worktree?.owned?.status).toBe('ready')
    expect(worktreeCount()).toBe(2)
  })

  it('fails closed on preparation errors, preserves main and allows a corrected retry', async () => {
    const { manager, createChat } = harness()
    const managed = createChat()
    managed.worktree!.baseBranch = 'missing-branch'
    await expect(manager.getOrCreateAgent(managed)).rejects.toThrow()
    expect(manager.getOrCreatePreparedAgent).not.toHaveBeenCalled()
    expect(managed.agent).toBeNull()
    expect(managed.workingDirectory).toBe(repository)
    expect(worktreeCount()).toBe(1)
    expect(git(repository, 'symbolic-ref', '--short', 'HEAD')).toBe('main')

    managed.worktree!.baseBranch = 'main'
    await manager.getOrCreateAgent(managed)
    expect(manager.getOrCreatePreparedAgent).toHaveBeenCalledTimes(1)
    expect(worktreeCount()).toBe(2)
  })

  it('requires ownership to reach disk before creating any Git checkout or reservation', async () => {
    const { manager, createChat } = harness()
    const managed = createChat()
    // A file in place of the workspace directory makes the real persistence
    // queue fail. Its flush logs rather than throws; the lifecycle must verify disk.
    const blockedWorkspace = join(root, 'blocked-workspace')
    writeFileSync(blockedWorkspace, 'not a directory')
    managed.workspace = { ...workspace, rootPath: blockedWorkspace }
    await expect(manager.getOrCreateAgent(managed)).rejects.toThrow()
    const pending = managed.worktree!.owned!
    expect(pending.status).toBe('pending')
    expect(existsSync(pending.path)).toBe(false)
    expect(existsSync(join(pending.gitDir, 'craft-session-worktrees'))).toBe(false)
    expect(git(repository, 'branch', '--list', pending.branch)).toBe('')
    expect(manager.getOrCreatePreparedAgent).not.toHaveBeenCalled()
    expect(worktreeCount()).toBe(1)

    managed.workspace = workspace
    await manager.getOrCreateAgent(managed)
    expect(managed.worktree?.owned?.token).toBe(pending.token)
    expect(loadSession(workspace.rootPath, managed.id)?.worktree?.owned?.status).toBe('ready')
  })

  it('persists the pending plan before Git and the ready cwd before backend creation', async () => {
    const { manager, createChat } = harness()
    const managed = createChat()
    const flush = manager.flushSession.bind(manager)
    const states: Array<{ status?: string; exists: boolean }> = []
    manager.flushSession = async (id) => {
      await flush(id)
      const owned = readSessionHeader(getSessionFilePath(workspace.rootPath, id))?.worktree?.owned
      states.push({ status: owned?.status, exists: !!owned && existsSync(owned.path) })
    }
    await manager.getOrCreateAgent(managed)
    expect(states).toEqual([{ status: 'pending', exists: false }, { status: 'ready', exists: true }])
  })

  it('does not move an already initialized SDK session from the project checkout', async () => {
    const { manager, createChat } = harness()
    const managed = createChat({ sdkSessionId: 'existing-main-session' })
    await expect(manager.getOrCreateAgent(managed)).rejects.toThrow()
    expect(manager.getOrCreatePreparedAgent).not.toHaveBeenCalled()
    expect(managed.worktree?.owned).toBeUndefined()
    expect(managed.sdkCwd).toBe(repository)
    expect(worktreeCount()).toBe(1)
  })

  it('rejects another chat ownership record instead of sharing its runtime cwd', async () => {
    const { manager, createChat } = harness()
    const owner = createChat()
    await manager.getOrCreateAgent(owner)
    manager.getOrCreatePreparedAgent.mockClear()
    const other = createChat({ worktree: structuredClone(owner.worktree) })
    await expect(manager.getOrCreateAgent(other)).rejects.toThrow()
    expect(manager.getOrCreatePreparedAgent).not.toHaveBeenCalled()
    expect(other.sdkCwd).toBe(repository)
    expect(existsSync(owner.worktree!.owned!.path)).toBe(true)
    expect(worktreeCount()).toBe(2)
  })

  it('acknowledges the durable user message and stops processing when worktree preparation fails', async () => {
    const { manager, internals, managed, events } = sendHarness()
    const invalidRepository = join(root, 'not-a-git-repository')
    mkdirSync(invalidRepository)
    managed.worktree!.repositoryPath = invalidRepository
    const ack = mock((messageId: string) => {
      expect(loadSession(workspace.rootPath, managed.id)?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: messageId, type: 'user', content: 'Start the isolated task' }),
      ]))
      expect(events.some(event => event.type === 'error')).toBe(false)
    })

    await manager.sendMessage(
      managed.id, 'Start the isolated task', undefined, undefined, undefined, undefined, undefined, ack,
    )
    await manager.flushSession(managed.id)

    expect(ack).toHaveBeenCalledTimes(1)
    expect(events.find(event => event.type === 'error')?.error).toContain('not a Git repository')
    expect(events.some(event => event.type === 'complete')).toBe(true)
    expect(managed.isProcessing).toBe(false)
    expect(managed.agent).toBeNull()
    expect(internals.getOrCreatePreparedAgent).not.toHaveBeenCalled()
    expect(managed.workingDirectory).toBe(repository)
    expect(git(repository, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(git(repository, 'status', '--porcelain')).toBe('')
    expect(worktreeCount()).toBe(1)
  })

  it('waits for pending preparation on deletion, never starts the backend and never recreates session storage', async () => {
    const { manager, internals, managed, events } = sendHarness()
    const preparationPaused = Promise.withResolvers<void>()
    const resumePreparation = Promise.withResolvers<void>()
    const flush = manager.flushSession.bind(manager)
    manager.flushSession = async (id) => {
      if (id === managed.id && managed.worktree?.owned?.status === 'pending') {
        // Gate only the ownership flush; leave the earlier user-message/ack flush real.
        manager.flushSession = flush
        preparationPaused.resolve()
        await resumePreparation.promise
      }
      await flush(id)
    }
    const latePersist = mock(() => {})
    const persist = internals.persistSession.bind(manager)
    internals.persistSession = (session) => {
      if (events.some(event => event.type === 'session_deleted')) latePersist()
      persist(session)
    }
    const ack = mock(() => {})
    const sending = manager.sendMessage(
      managed.id, 'Prepare then delete', undefined, undefined, undefined, undefined, undefined, ack,
    )
    await preparationPaused.promise
    const pending = managed.worktree!.owned!
    expect(ack).toHaveBeenCalledTimes(1)
    expect(existsSync(getSessionFilePath(workspace.rootPath, managed.id))).toBe(true)
    expect(existsSync(pending.path)).toBe(false)

    let deletionFinished = false
    const deleting = manager.deleteSession(managed.id).then(() => { deletionFinished = true })
    expect(managed.isDeleting).toBe(true)
    await Promise.resolve()
    expect(deletionFinished).toBe(false)
    expect(internals.sessions.has(managed.id)).toBe(true)

    resumePreparation.resolve()
    await Promise.all([sending, deleting])
    await new Promise<void>(resolve => setImmediate(resolve))
    // Flush any mistakenly enqueued late write so the test detects recreated files.
    await manager.flushSession(managed.id)

    expect(internals.getOrCreatePreparedAgent).not.toHaveBeenCalled()
    expect(internals.sessions.has(managed.id)).toBe(false)
    expect(events.filter(event => event.type === 'session_deleted')).toHaveLength(1)
    expect(latePersist).not.toHaveBeenCalled()
    expect(sessionPersistenceQueue.hasPending(managed.id)).toBe(false)
    expect(existsSync(getSessionFilePath(workspace.rootPath, managed.id))).toBe(false)
    expect(existsSync(pending.path)).toBe(false)
    expect(git(repository, 'branch', '--list', pending.branch)).toBe('')
    expect(worktreeCount()).toBe(1)
  })
})

describe('project worktree policy boundaries', () => {
  const project = {
    workingDirectory: '/server/repo',
    worktreeSettings: { enabled: true, baseBranch: 'main', cleanupOnArchive: true },
  }

  it('captures the project default for a new independent chat', () => {
    expect(resolveSessionWorktreePolicy(project, { workingDirectory: 'user_default' })).toEqual({
      repositoryPath: '/server/repo', baseBranch: 'main', cleanupOnArchive: true,
    })
    expect(resolveSessionWorktreePolicy({ ...project, worktreeSettings: { enabled: false } })).toBeUndefined()
  })

  it('respects explicit opt-out and explicit working directories', () => {
    expect(resolveSessionWorktreePolicy(project, { worktree: 'none' })).toBeUndefined()
    expect(resolveSessionWorktreePolicy(project, { workingDirectory: '/server/repo' })).toBeUndefined()
    expect(resolveSessionWorktreePolicy(project, { workingDirectory: 'none' })).toBeUndefined()
  })

  it('excludes branches, subtasks, utility sessions and task runs from automatic isolation', () => {
    const inheritedOrInternal: CreateSessionOptions[] = [
      { branchFromSessionId: 'parent', branchFromMessageId: 'message' },
      { parentSessionId: 'parent' },
      { hidden: true },
      { systemPromptPreset: 'mini' },
      { taskSlug: 'task' },
      { taskRunId: 'run', taskNodeId: 'node' },
      { taskDraft: true },
    ]
    for (const options of inheritedOrInternal) {
      expect(resolveSessionWorktreePolicy(project, options)).toBeUndefined()
    }
  })
})
