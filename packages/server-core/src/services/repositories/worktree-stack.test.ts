import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OwnedWorktree } from '@craft-agent/shared/sessions'
import { captureStackParent, getWorktreeStack, type StackSession } from './worktree-stack'
import { commonGitDir } from './discover'
import { resolveRepositoryStart } from './start-context'
import { planOwnedWorktree } from './owned-worktree'

let root: string, repo: string, a: string, b: string, initial: string, baseCommit: string, plan: OwnedWorktree
let sessions: StackSession[]
function git(path: string, ...args: string[]): string {
  return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function commit(path: string, file: string, text: string): string {
  writeFileSync(join(path, file), text)
  git(path, 'add', '--', file); git(path, 'commit', '-qm', text)
  return git(path, 'rev-parse', 'HEAD')
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'craft-stack-'))
  repo = join(root, 'repo'); a = join(root, 'a'); b = join(root, 'b')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid')
  initial = commit(repo, 'base.txt', 'base')
  git(repo, 'worktree', 'add', '-qb', 'test/A', a, 'main')
  baseCommit = commit(a, 'a.txt', 'A initial')
  git(repo, 'worktree', 'add', '-qb', 'test/B', b, 'test/A')
  commit(b, 'b.txt', 'B initial')
  plan = { version: 1, ownerId: 'workspace/B', token: 'fixture', repoPath: repo, gitDir: (await commonGitDir(repo))!,
    path: b, branch: 'test/B', base: 'refs/heads/test/A', baseCommit, status: 'ready' }
  sessions = [
    { id: 'A', name: 'Parent', workspaceId: 'workspace', workingDirectory: a },
    { id: 'B', name: 'Child', workspaceId: 'workspace', workingDirectory: b, worktree: { repositoryPath: repo, owned: plan } },
  ]
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
async function associate() {
  const parent = await captureStackParent({ sessionId: 'B', workspaceId: 'workspace', requestedBranch: 'test/A', plan, sessions })
  sessions[1]!.worktree!.stackParent = parent
  return parent
}
const snapshot = () => getWorktreeStack({ session: sessions.find(session => session.id === 'B')!, sessions })

test('records exact allocation base and identifies a verified same-repository parent', async () => {
  const parent = await associate()
  expect(parent).toMatchObject({ branch: 'test/A', baseCommit, parentSessionId: 'A', association: 'verified' })
  const state = await snapshot()
  expect(state.parent?.state).toBe('up-to-date')
  const top = await getWorktreeStack({ session: sessions[0]!, sessions })
  expect(top.children.map(child => child.sessionId)).toEqual(['B'])
})

test('associates the actual parent branch when saved checkout metadata is stale', async () => {
  sessions[0]!.worktree = { repositoryPath: repo, owned: { ...plan, path: a, branch: 'test/A', checkout: { branch: 'test/A', commit: baseCommit } } }
  git(a, 'switch', '-qc', 'test/renamed')
  const renamed = await captureStackParent({
    sessionId: 'B', workspaceId: 'workspace', requestedBranch: 'test/renamed',
    plan: { ...plan, base: 'refs/heads/test/renamed' }, sessions,
  })
  expect(renamed.association).toBe('verified')
  expect(renamed.parentSessionId).toBe('A')
  const old = await associate()
  expect(old.association).toBe('unmapped')
  expect(old.parentSessionId).toBeUndefined()
})

test('explicit branch copies use the verified local parent even when origin tracking is behind', async () => {
  git(repo, 'update-ref', 'refs/remotes/origin/test/A', initial)
  const start = await resolveRepositoryStart(repo, { kind: 'branch', branch: 'test/A', copy: true })
  expect(start.baseBranch).toBe('refs/heads/test/A')
  const allocated = await planOwnedWorktree({ repositoryPath: repo, ownerId: 'workspace/new-child', sessionId: 'new-child', taskTitle: 'new child', baseBranch: start.baseBranch })
  expect(allocated.baseCommit).toBe(baseCommit)
  expect(allocated.baseCommit).not.toBe(initial)
})

test('detects parent advancement and clears the warning after an owner-performed local restack', async () => {
  await associate()
  commit(a, 'a.txt', 'A advanced')
  expect((await snapshot()).parent?.state).toBe('needs-restack')
  git(b, 'rebase', 'test/A')
  expect((await snapshot()).parent?.state).toBe('up-to-date')
})

test('reports rewritten parent history even when the older parent is still an ancestor of the child', async () => {
  await associate()
  git(a, 'reset', '--hard', initial)
  expect((await snapshot()).parent?.state).toBe('diverged')
  git(b, 'rebase', '--onto', 'test/A', baseCommit)
  expect((await snapshot()).parent?.state).toBe('up-to-date')
})

test('does not guess a parent among duplicate sessions or another workspace', async () => {
  sessions.push({ ...sessions[0]!, id: 'shadow' })
  expect((await associate()).association).toBe('ambiguous')
  expect((await snapshot()).parent?.state).toBe('ambiguous')
  sessions = sessions.filter(item => item.id !== 'shadow')
  sessions[0]!.workspaceId = 'other'
  expect((await associate()).association).toBe('unmapped')
  expect(sessions[1]!.worktree!.stackParent?.parentSessionId).toBeUndefined()
})

test('same branch name in another repository never establishes parent identity', async () => {
  const unrelated = join(root, 'other')
  execFileSync('git', ['init', '-q', '-b', 'test/A', unrelated])
  sessions[0]!.workingDirectory = unrelated
  expect((await associate()).association).toBe('unmapped')
})

test('hidden helpers sharing the parent checkout do not become duplicate visible stack parents', async () => {
  sessions.push({ ...sessions[0]!, id: 'hidden-helper', hidden: true }, { ...sessions[0]!, id: 'child-helper', parentSessionId: 'A' })
  expect((await associate()).parentSessionId).toBe('A')
})

test('missing parent and switched parent branches remain distinct', async () => {
  await associate()
  git(a, 'switch', '-qc', 'test/unrelated')
  expect((await snapshot()).parent?.state).toBe('parent-switched')
  sessions = sessions.filter(session => session.id !== 'A')
  expect((await snapshot()).parent?.state).toBe('missing-parent')
})

test('saved cycles and cross-repository metadata are refused without any Git writes', async () => {
  await associate()
  sessions[0]!.worktree = { repositoryPath: repo, stackParent: { ...sessions[1]!.worktree!.stackParent!, parentSessionId: 'B' } }
  expect((await snapshot()).parent?.state).toBe('cycle')
  delete sessions[0]!.worktree
  sessions[1]!.worktree!.stackParent!.repositoryGitDir = join(root, 'other', '.git')
  expect((await snapshot()).parent?.state).toBe('unknown')
})

test('cached merged evidence is explicit and archived parents remain navigable without receiving prompts', async () => {
  await associate(); sessions[0]!.isArchived = true
  const before = git(repo, 'show-ref')
  const state = await getWorktreeStack({ session: sessions[1]!, sessions, parentMerged: true, now: 123 })
  expect(state.parent?.merged).toBe(true)
  expect(state.parent?.session?.archived).toBe(true)
  expect(state.observedAt).toBe(123)
  expect(git(repo, 'show-ref')).toBe(before)
})
