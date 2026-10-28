import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adoptExistingWorktree, ensureOwnedWorktree, planOwnedWorktree, removeOwnedWorktree } from './owned-worktree'
import { captureSessionCheckpoint, listSessionCheckpoints, restoreSessionCheckpoint } from '../checkpoints/session-checkpoints'

let root: string, repo: string
const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'craft-adoption-')))
  repo = join(root, 'repo')
  git(root, 'init', '--quiet', '-b', 'main', repo)
  writeFileSync(join(repo, 'code.txt'), 'original\n')
  writeFileSync(join(repo, '.gitignore'), '.env\n')
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src', 'nested.txt'), 'nested\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '--quiet', '-m', 'Initial')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('explicit association retains staged, dirty, untracked and ignored files without changing the branch or index', async () => {
  writeFileSync(join(repo, 'code.txt'), 'staged\n'); git(repo, 'add', 'code.txt')
  writeFileSync(join(repo, 'code.txt'), 'dirty\n')
  writeFileSync(join(repo, 'new.txt'), 'untracked\n')
  writeFileSync(join(repo, '.env'), 'local fixture\n')
  const before = { head: git(repo, 'rev-parse', 'HEAD'), index: readFileSync(join(repo, '.git', 'index')), status: git(repo, 'status', '--porcelain=v1', '--ignored') }
  const plan = await adoptExistingWorktree({ directory: join(repo, 'src'), ownerId: 'workspace/imported' })
  expect(plan.adopted).toBe(true)
  expect(plan.projectSubdirectory).toBe('src')
  expect(plan.path).toBe(repo)
  expect(plan.status).toBe('ready')
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(before.head)
  expect(git(repo, 'branch', '--show-current')).toBe('main')
  expect(readFileSync(join(repo, '.git', 'index'))).toEqual(before.index)
  expect(git(repo, 'status', '--porcelain=v1', '--ignored')).toBe(before.status)
  expect(readFileSync(join(repo, 'code.txt'), 'utf8')).toBe('dirty\n')
  expect(readFileSync(join(repo, '.env'), 'utf8')).toBe('local fixture\n')
  expect((await ensureOwnedWorktree(plan)).path).toBe(repo)
})

test('association retries recover the durable same-owner reservation and never allow another owner', async () => {
  const first = await adoptExistingWorktree({ directory: repo, ownerId: 'workspace/one' })
  expect((await adoptExistingWorktree({ directory: repo, ownerId: first.ownerId })).token).toBe(first.token)
  await expect(adoptExistingWorktree({ directory: repo, ownerId: 'workspace/two' })).rejects.toThrow('owns this checkout')
  const [a, b] = await Promise.allSettled([
    adoptExistingWorktree({ directory: join(repo, 'src'), ownerId: 'workspace/three' }),
    adoptExistingWorktree({ directory: join(repo, 'src'), ownerId: 'workspace/four' }),
  ])
  expect(a.status).toBe('rejected'); expect(b.status).toBe('rejected')
})

test('concurrent initial associations grant the existing checkout to exactly one owner', async () => {
  const results = await Promise.allSettled(['a', 'b'].map(id => adoptExistingWorktree({ directory: repo, ownerId: `workspace/${id}` })))
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
})

test('existing Craft ownership cannot be adopted by a different chat', async () => {
  const original = await ensureOwnedWorktree(await planOwnedWorktree({ repositoryPath: repo, ownerId: 'workspace/original', sessionId: 'original', baseBranch: 'refs/heads/main', taskTitle: 'Original' }))
  await expect(adoptExistingWorktree({ directory: original.path, ownerId: 'workspace/import' })).rejects.toThrow('owns this checkout')
  expect(git(original.path, 'branch', '--show-current')).toBe(original.branch)
})

test('adopted checkouts cannot be removed or recreated by Craft', async () => {
  const existing = join(root, 'imported-checkout')
  git(repo, 'worktree', 'add', '--quiet', '-b', 'imported', existing)
  const plan = await adoptExistingWorktree({ directory: existing, ownerId: 'workspace/import' })
  expect(await removeOwnedWorktree(plan)).toEqual({ removed: false, reason: 'Explicitly associated worktrees are retained' })
  git(repo, 'worktree', 'remove', existing)
  await expect(ensureOwnedWorktree(plan)).rejects.toThrow()
  expect(existsSync(existing)).toBe(false)
  expect(git(repo, 'rev-parse', 'refs/heads/imported')).toBe(plan.baseCommit)
})

test('association creates no historical snapshots; new turns can capture and restore through the existing checkpoint engine', async () => {
  const plan = await adoptExistingWorktree({ directory: repo, ownerId: 'workspace/imported' })
  const sessionDir = join(root, 'history'); mkdirSync(sessionDir)
  writeFileSync(join(sessionDir, 'session.jsonl'), JSON.stringify({ id: 'imported' }) + '\n' + JSON.stringify({ id: 'next-turn', type: 'user', content: 'Continue', timestamp: 1 }) + '\n')
  const context = { plan, sessionDir }
  expect((await listSessionCheckpoints(context)).checkpoints).toEqual([])
  const snapshot = await captureSessionCheckpoint(context, 'next-turn')
  writeFileSync(join(repo, 'code.txt'), 'future change\n')
  let restored = false
  await restoreSessionCheckpoint({ ...context, checkpointId: snapshot.id, assertIdle() {}, async restoreConversation() { restored = true }, async rollbackConversation() {} })
  expect(restored).toBe(true)
  expect(readFileSync(join(repo, 'code.txt'), 'utf8')).toBe('original\n')
  expect(git(repo, 'branch', '--show-current')).toBe('main')
})
