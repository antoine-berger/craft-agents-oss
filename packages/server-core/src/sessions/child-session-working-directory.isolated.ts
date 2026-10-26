import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as config from '@craft-agent/shared/config'
import * as workspaces from '@craft-agent/shared/workspaces'
import * as storage from '@craft-agent/shared/sessions'
import { createProject } from '@craft-agent/shared/projects'
import { setupI18n } from '@craft-agent/shared/i18n'
import type { CreateSessionOptions } from '@craft-agent/shared/protocol'
import { createManagedSession, SessionManager } from './SessionManager.ts'

// Run alone because config lookups are process-wide. Session creation, persistence,
// worktree preparation and cleanup stay real; no model or credential calls are made.
type ManagedSession = ReturnType<typeof createManagedSession>
type Internals = {
  sessions: Map<string, ManagedSession>
  withWorktreeLock<T>(managed: ManagedSession, operation: () => Promise<T>): Promise<T>
  prepareSessionWorktree(managed: ManagedSession): Promise<void>
  cleanupSessionWorktree(managed: ManagedSession): Promise<void>
}

const spies: Array<{ mockRestore(): void }> = []
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Child Cwd Test', GIT_AUTHOR_EMAIL: 'child-cwd@example.invalid',
  GIT_COMMITTER_NAME: 'Child Cwd Test', GIT_COMMITTER_EMAIL: 'child-cwd@example.invalid',
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'],
}).trim()

let root: string
let repository: string
let workspace: config.Workspace
let projectId: string
let manager: SessionManager
let internals: Internals

beforeAll(() => { setupI18n() })

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'child-session-cwd-')))
  repository = join(root, 'repo')
  mkdirSync(repository)
  git(repository, 'init', '-b', 'main')
  writeFileSync(join(repository, 'code.txt'), 'Main checkout stays unchanged\n')
  git(repository, 'add', '.')
  git(repository, 'commit', '-m', 'Initial commit')
  workspace = { id: 'child-cwd-workspace', slug: 'test', name: 'Test', rootPath: join(root, 'workspace'), createdAt: 1 }
  mkdirSync(workspace.rootPath)
  projectId = createProject(workspace.rootPath, {
    name: 'Initiative', workingDirectory: repository,
    worktreeSettings: { enabled: true, baseBranch: 'main', cleanupOnArchive: true },
  }).id

  spies.push(spyOn(config, 'getWorkspaceByNameOrId').mockImplementation(id => id === workspace.id ? workspace : null))
  spies.push(spyOn(config, 'getLlmConnection').mockReturnValue(null))
  spies.push(spyOn(config, 'getDefaultLlmConnection').mockReturnValue(null))
  spies.push(spyOn(config, 'getDefaultThinkingLevel').mockReturnValue('medium'))
  spies.push(spyOn(config, 'loadConfigDefaults').mockReturnValue({
    workspaceDefaults: { permissionMode: 'ask', thinkingLevel: 'medium' },
  } as ReturnType<typeof config.loadConfigDefaults>))
  spies.push(spyOn(workspaces, 'loadWorkspaceConfig').mockReturnValue({
    defaults: { permissionMode: 'ask', workingDirectory: join(root, 'workspace-default') },
  } as ReturnType<typeof workspaces.loadWorkspaceConfig>))
  manager = new SessionManager()
  manager.setEventSink(() => {})
  internals = manager as unknown as Internals
})

afterEach(async () => {
  for (const id of internals.sessions.keys()) {
    await storage.sessionPersistenceQueue.flush(id)
    storage.sessionPersistenceQueue.cancel(id)
  }
  for (const spy of spies.splice(0)) spy.mockRestore()
  rmSync(root, { recursive: true, force: true })
})

async function parentSession(options: CreateSessionOptions = {}) {
  const parent = await manager.createSession(workspace.id, { name: 'Parent', projectId, ...options })
  return internals.sessions.get(parent.id)!
}

async function prepare(parent: ManagedSession) {
  await internals.withWorktreeLock(parent, () => internals.prepareSessionWorktree(parent))
  return parent.worktree!.owned!.path
}

describe('child session working directory', () => {
  for (const explicitProject of [false, true]) {
    it(`inherits the prepared parent worktree with ${explicitProject ? 'an explicit' : 'an inherited'} project`, async () => {
      const parent = await parentSession()
      const checkout = await prepare(parent)
      const child = await manager.createSession(workspace.id, {
        parentSessionId: parent.id, ...(explicitProject ? { projectId } : {}),
      })

      expect(child.workingDirectory).toBe(checkout)
      expect(child.projectId).toBe(projectId)
      expect(child.parentSessionId).toBe(parent.id)
      const persisted = storage.loadSession(workspace.rootPath, child.id)!
      expect(persisted.workingDirectory).toBe(checkout)
      expect(persisted.sdkCwd).toBe(checkout)
      expect(persisted.worktree).toBeUndefined()
      expect(git(repository, 'status', '--porcelain')).toBe('')
      expect(git(repository, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(2)
    })
  }

  it('prepares one checkout for concurrent quick-add children before the parent has started', async () => {
    const parent = await parentSession()
    expect(parent.worktree?.owned).toBeUndefined()
    const children = await Promise.all([
      manager.createSession(workspace.id, { parentSessionId: parent.id }),
      manager.createSession(workspace.id, { parentSessionId: parent.id }),
    ])
    const checkout = parent.worktree!.owned!.path
    expect(checkout).not.toBe(repository)
    expect(parent.agent).toBeNull()
    expect(parent.worktree?.owned?.status).toBe('ready')
    expect(children.map(child => child.workingDirectory)).toEqual([checkout, checkout])
    expect(git(repository, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(2)
  })

  it('keeps a parent subdirectory when the parent has an explicit cwd', async () => {
    const directory = join(root, 'existing-checkout', 'packages', 'api')
    mkdirSync(directory, { recursive: true })
    const parent = await parentSession({ workingDirectory: directory })
    const child = await manager.createSession(workspace.id, { parentSessionId: parent.id })
    expect(child.workingDirectory).toBe(directory)
    expect(storage.loadSession(workspace.rootPath, child.id)?.sdkCwd).toBe(directory)
    expect(internals.sessions.get(child.id)?.worktree).toBeUndefined()
  })

  it('preserves a parent with no cwd instead of restoring the project repo', async () => {
    const parent = await parentSession({ workingDirectory: 'none' })
    const child = await manager.createSession(workspace.id, { parentSessionId: parent.id })
    expect(child.workingDirectory).toBeUndefined()
    expect(storage.loadSession(workspace.rootPath, child.id)?.sdkCwd).toBe(storage.getSessionPath(workspace.rootPath, child.id))
  })

  for (const override of ['none', 'user_default', 'explicit'] as const) {
    it(`preserves an explicit ${override} directory override`, async () => {
      const parent = await parentSession()
      const checkout = await prepare(parent)
      const workingDirectory = override === 'explicit' ? join(root, 'chosen') : override
      const child = await manager.createSession(workspace.id, { parentSessionId: parent.id, workingDirectory })
      const expected = override === 'none' ? undefined : override === 'user_default' ? repository : workingDirectory
      expect(child.workingDirectory).toBe(expected)
      expect(child.workingDirectory).not.toBe(checkout)
      expect(internals.sessions.get(child.id)?.worktree).toBeUndefined()
    })
  }

  it('uses a different explicitly selected project without adopting the parent checkout', async () => {
    const otherDirectory = join(root, 'other-repo')
    mkdirSync(otherDirectory)
    const otherProject = createProject(workspace.rootPath, { name: 'Other', workingDirectory: otherDirectory })
    const parent = await parentSession()
    await prepare(parent)
    const child = await manager.createSession(workspace.id, { parentSessionId: parent.id, projectId: otherProject.id })
    expect(child.workingDirectory).toBe(otherDirectory)
    expect(child.projectId).toBe(otherProject.id)
    expect(internals.sessions.get(child.id)?.worktree).toBeUndefined()
  })

  it('inherits an unbound parent directory without requiring a project', async () => {
    const parent = await parentSession({ projectId: undefined, workingDirectory: join(root, 'custom') })
    const child = await manager.createSession(workspace.id, { parentSessionId: parent.id })
    expect(child.projectId).toBeUndefined()
    expect(child.workingDirectory).toBe(parent.workingDirectory)
  })

  it('keeps archive cleanup waiting until the inheriting child is registered', async () => {
    const parent = await parentSession()
    const checkout = await prepare(parent)
    const storing = Promise.withResolvers<void>()
    const releaseStorage = Promise.withResolvers<void>()
    const createStoredSession = storage.createSession
    spies.push(spyOn(storage, 'createSession').mockImplementation(async (...args) => {
      storing.resolve()
      await releaseStorage.promise
      return createStoredSession(...args)
    }))
    const creatingChild = manager.createSession(workspace.id, { parentSessionId: parent.id })
    await storing.promise
    parent.isArchived = true
    const cleanup = internals.cleanupSessionWorktree(parent)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(existsSync(checkout)).toBe(true)
    releaseStorage.resolve()
    const child = await creatingChild
    await cleanup
    expect(child.workingDirectory).toBe(checkout)
    expect(existsSync(checkout)).toBe(true)
    expect(parent.worktree?.owned?.status).toBe('ready')
  })

  it('does not create a child in the main checkout when parent worktree preparation fails', async () => {
    const parent = await parentSession()
    parent.worktree!.baseBranch = 'missing-base'
    await expect(manager.createSession(workspace.id, { parentSessionId: parent.id })).rejects.toThrow()
    expect(internals.sessions.size).toBe(1)
    expect(git(repository, 'status', '--porcelain')).toBe('')
  })

  for (const unavailable of ['missing', 'foreign-workspace', 'deleting'] as const) {
    it(`rejects a ${unavailable} parent instead of silently using project defaults`, async () => {
      const parent = await parentSession()
      if (unavailable === 'missing') internals.sessions.delete(parent.id)
      if (unavailable === 'foreign-workspace') parent.workspace = { ...workspace, rootPath: join(root, 'other-workspace') }
      if (unavailable === 'deleting') parent.isDeleting = true
      const sessionCount = internals.sessions.size
      await expect(manager.createSession(workspace.id, { parentSessionId: parent.id })).rejects.toThrow()
      expect(internals.sessions.size).toBe(sessionCount)
    })
  }
})
