import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OwnedWorktree } from '@craft-agent/shared/sessions'
import { ensureOwnedWorktree, OwnedWorktreeError, planOwnedWorktree, removeOwnedWorktree } from './owned-worktree'

let root: string
let repo: string
const env = { ...process.env, GIT_AUTHOR_NAME: 'Worktree Test', GIT_AUTHOR_EMAIL: 'worktree@example.invalid', GIT_COMMITTER_NAME: 'Worktree Test', GIT_COMMITTER_EMAIL: 'worktree@example.invalid' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'owned-worktree-')))
  const origin = join(root, 'origin.git')
  git(root, 'init', '--bare', '-b', 'main', origin)
  repo = join(root, 'repo')
  git(root, 'clone', origin, repo)
  writeFileSync(join(repo, 'code.txt'), 'original\n')
  writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules/\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'Initial commit')
  git(repo, 'push', 'origin', 'main')
  git(repo, 'remote', 'set-head', 'origin', '-a')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const plan = (sessionId = 'test-session', baseBranch?: string) => planOwnedWorktree({ repositoryPath: repo, ownerId: `workspace/${sessionId}`, sessionId, baseBranch })

describe('session-owned worktrees', () => {
  it('creates separate branches/checkouts for parallel chats without touching the project checkout', async () => {
    const [firstPlan, secondPlan] = await Promise.all([plan('first'), plan('second')])
    expect(existsSync(firstPlan.path)).toBe(false)
    const [first, second] = await Promise.all([ensureOwnedWorktree(firstPlan), ensureOwnedWorktree(secondPlan)])
    expect(first.path).not.toBe(second.path)
    expect(first.branch).not.toBe(second.branch)
    expect(git(first.path, 'symbolic-ref', '--short', 'HEAD')).toBe(first.branch)
    expect(git(second.path, 'symbolic-ref', '--short', 'HEAD')).toBe(second.branch)
    writeFileSync(join(first.path, 'code.txt'), 'first session\n')
    expect(readFileSync(join(second.path, 'code.txt'), 'utf8')).toBe('original\n')
    expect(readFileSync(join(repo, 'code.txt'), 'utf8')).toBe('original\n')
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
  })

  it('retries the persisted plan concurrently and after a restart without creating another checkout', async () => {
    const pending = await plan()
    const [first, second] = await Promise.all([ensureOwnedWorktree(pending), ensureOwnedWorktree(pending)])
    expect(first).toEqual(second)
    // A crash after Git creation but before the ready state was saved leaves the pending plan.
    const recovered = await ensureOwnedWorktree(JSON.parse(JSON.stringify(pending)) as OwnedWorktree)
    expect(recovered.path).toBe(first.path)
    const resumed = await ensureOwnedWorktree(JSON.parse(JSON.stringify(first)) as OwnedWorktree)
    expect(resumed).toEqual(first)
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(2)
  })

  it('keeps the original base commit even when the branch advances after planning', async () => {
    const pending = await plan()
    writeFileSync(join(repo, 'later.txt'), 'later')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'Advance main')
    const ready = await ensureOwnedWorktree(pending)
    expect(git(ready.path, 'rev-parse', 'HEAD')).toBe(pending.baseCommit)
    expect(existsSync(join(ready.path, 'later.txt'))).toBe(false)
  })

  it('does not start an agent in a checkout interrupted before its index was written', async () => {
    const pending = await plan()
    const ready = await ensureOwnedWorktree(pending)
    // Represent a process crash during git worktree add: registration exists, but no index or files.
    const markerFolder = join(ready.gitDir, 'craft-session-worktrees')
    const marker = join(markerFolder, readdirSync(markerFolder).find(name => name.endsWith('.json'))!)
    writeFileSync(marker, JSON.stringify(pending))
    rmSync(git(ready.path, 'rev-parse', '--git-path', 'index'))
    rmSync(join(ready.path, 'code.txt'))
    await expect(ensureOwnedWorktree(pending)).rejects.toThrow('interrupted worktree')
    expect(existsSync(ready.path)).toBe(true)
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
  })

  it('uses a configured base branch and never silently falls back when it is missing', async () => {
    git(repo, 'switch', '-c', 'release')
    writeFileSync(join(repo, 'release.txt'), 'release')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'Release')
    git(repo, 'switch', 'main')
    const ready = await ensureOwnedWorktree(await plan('release-session', 'release'))
    expect(existsSync(join(ready.path, 'release.txt'))).toBe(true)
    await expect(plan('missing-session', 'does-not-exist')).rejects.toThrow('does not exist')
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(2)
  })

  it('resolves exact branch refs when tags have the same names, and rejects a tag-only base', async () => {
    const original = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'branch', 'release')
    writeFileSync(join(repo, 'later.txt'), 'later')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'Advance main')
    git(repo, 'tag', 'release')
    git(repo, 'tag', 'origin/main')
    git(repo, 'tag', 'only-a-tag')
    expect((await plan('local-base', 'release')).baseCommit).toBe(original)
    expect((await plan('default-base')).baseCommit).toBe(original)
    await expect(plan('tag-only-base', 'only-a-tag')).rejects.toThrow('does not exist')
  })

  it('restores a cleaned worktree from its existing branch, preserving session commits', async () => {
    const ready = await ensureOwnedWorktree(await plan())
    writeFileSync(join(ready.path, 'feature.txt'), 'keep my work')
    git(ready.path, 'add', '.')
    git(ready.path, 'commit', '-m', 'Session work')
    const commit = git(ready.path, 'rev-parse', 'HEAD')
    expect(await removeOwnedWorktree(ready)).toEqual({ removed: true })
    expect(existsSync(ready.path)).toBe(false)
    expect(git(repo, 'rev-parse', `refs/heads/${ready.branch}`)).toBe(commit)
    const restored = await ensureOwnedWorktree({ ...ready, status: 'removed' })
    expect(restored.path).toBe(ready.path)
    expect(git(restored.path, 'rev-parse', 'HEAD')).toBe(commit)
    expect(readFileSync(join(restored.path, 'feature.txt'), 'utf8')).toBe('keep my work')
  })

  it('does not reuse a ready marker from an old checkout when restoration fails', async () => {
    const ready = await ensureOwnedWorktree(await plan())
    writeFileSync(join(ready.path, '.gitattributes'), '*.txt filter=unavailable\n')
    git(ready.path, 'add', '.')
    git(ready.path, 'commit', '-m', 'Require a smudge filter')
    expect((await removeOwnedWorktree(ready)).removed).toBe(true)
    git(repo, 'config', 'filter.unavailable.smudge', 'false')
    git(repo, 'config', 'filter.unavailable.required', 'true')
    await expect(ensureOwnedWorktree({ ...ready, status: 'removed' })).rejects.toBeInstanceOf(OwnedWorktreeError)
    const markerFolder = join(ready.gitDir, 'craft-session-worktrees')
    const marker = join(markerFolder, readdirSync(markerFolder).find(name => name.endsWith('.json'))!)
    expect(JSON.parse(readFileSync(marker, 'utf8')).status).toBe('pending')
    expect(git(repo, 'show', `${ready.branch}:code.txt`)).toBe('original')
  })

  for (const dirtyFile of ['code.txt', 'untracked.txt', '.env', 'node_modules/package/data.txt']) {
    it(`preserves a worktree containing ${dirtyFile}`, async () => {
      const ready = await ensureOwnedWorktree(await plan())
      if (dirtyFile.includes('/')) mkdirSync(join(ready.path, 'node_modules/package'), { recursive: true })
      writeFileSync(join(ready.path, dirtyFile), 'must not be deleted')
      const result = await removeOwnedWorktree(ready)
      expect(result.removed).toBe(false)
      expect(readFileSync(join(ready.path, dirtyFile), 'utf8')).toBe('must not be deleted')
    })
  }

  for (const indexFlag of ['--assume-unchanged', '--skip-worktree']) {
    it(`preserves files hidden from git status by ${indexFlag}`, async () => {
      const ready = await ensureOwnedWorktree(await plan())
      git(ready.path, 'update-index', indexFlag, 'code.txt')
      writeFileSync(join(ready.path, 'code.txt'), 'hidden local change')
      expect(git(ready.path, 'status', '--porcelain')).toBe('')
      expect((await removeOwnedWorktree(ready)).removed).toBe(false)
      expect(readFileSync(join(ready.path, 'code.txt'), 'utf8')).toBe('hidden local change')
    })
  }

  it('does not claim an existing worktree just because its path and branch match a plan', async () => {
    const pending = await plan()
    git(repo, 'worktree', 'add', '-b', pending.branch, pending.path, 'main')
    await expect(ensureOwnedWorktree(pending)).rejects.toThrow('without session ownership')
    expect((await removeOwnedWorktree(pending)).removed).toBe(false)
    expect(existsSync(pending.path)).toBe(true)
  })

  it('does not claim a pre-existing branch and does not replace an unrelated target directory', async () => {
    const branchPlan = await plan('branch-collision')
    git(repo, 'branch', branchPlan.branch)
    await expect(ensureOwnedWorktree(branchPlan)).rejects.toBeInstanceOf(OwnedWorktreeError)
    const directoryPlan = await plan('directory-collision')
    mkdirSync(directoryPlan.path)
    writeFileSync(join(directoryPlan.path, 'unrelated.txt'), 'keep')
    await expect(ensureOwnedWorktree(directoryPlan)).rejects.toBeInstanceOf(OwnedWorktreeError)
    expect(readFileSync(join(directoryPlan.path, 'unrelated.txt'), 'utf8')).toBe('keep')
  })

  it('rejects altered ownership or paths and leaves the checkout intact', async () => {
    const ready = await ensureOwnedWorktree(await plan())
    await expect(ensureOwnedWorktree({ ...ready, token: 'different-owner' })).rejects.toThrow('Another session')
    await expect(removeOwnedWorktree({ ...ready, path: repo })).rejects.toBeInstanceOf(OwnedWorktreeError)
    expect(existsSync(ready.path)).toBe(true)
    expect(existsSync(join(repo, 'code.txt'))).toBe(true)
  })

  it('refuses cleanup after the worktree changes branch or is locked', async () => {
    const ready = await ensureOwnedWorktree(await plan())
    git(repo, 'worktree', 'lock', ready.path)
    expect((await removeOwnedWorktree(ready)).removed).toBe(false)
    git(repo, 'worktree', 'unlock', ready.path)
    git(ready.path, 'switch', '-c', 'someone-else')
    await expect(removeOwnedWorktree(ready)).rejects.toBeInstanceOf(OwnedWorktreeError)
    expect(existsSync(ready.path)).toBe(true)
  })

  it('does not recreate a deleted session branch from main after cleanup', async () => {
    const ready = await ensureOwnedWorktree(await plan())
    expect((await removeOwnedWorktree(ready)).removed).toBe(true)
    git(repo, 'branch', '-D', ready.branch)
    await expect(ensureOwnedWorktree({ ...ready, status: 'removed' })).rejects.toThrow('branch is missing')
    expect(existsSync(ready.path)).toBe(false)
  })

  it('supports bare repository layouts', async () => {
    const bare = join(root, 'layout', '.bare')
    mkdirSync(join(root, 'layout'))
    git(root, 'clone', '--bare', repo, bare)
    const pending = await planOwnedWorktree({ repositoryPath: bare, ownerId: 'workspace/bare-session', sessionId: 'bare-session' })
    const ready = await ensureOwnedWorktree(pending)
    expect(ready.path.startsWith(join(root, 'layout') + '/')).toBe(true)
    expect(readFileSync(join(ready.path, 'code.txt'), 'utf8')).toBe('original\n')
    expect((await removeOwnedWorktree(ready)).removed).toBe(true)
  })

  it('rejects ordinary directories and repositories without a commit', async () => {
    const folder = join(root, 'plain')
    mkdirSync(folder)
    await expect(planOwnedWorktree({ repositoryPath: folder, ownerId: 'x', sessionId: 'x' })).rejects.toThrow('not a Git repository')
    git(folder, 'init', '-b', 'main')
    await expect(planOwnedWorktree({ repositoryPath: folder, ownerId: 'x', sessionId: 'x' })).rejects.toThrow('initial commit')
    expect(git(folder, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  })
})
