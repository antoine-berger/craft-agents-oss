/**
 * Session-owned worktrees. The caller persists the plan before ensureOwnedWorktree so a retry or
 * restart uses the same branch and directory. A marker in the common Git directory records the
 * reservation before Git is called; merely finding a similarly named branch never establishes
 * ownership. Removal keeps the branch and refuses tracked, untracked AND ignored local files.
 */

import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { OwnedWorktree } from '@craft-agent/shared/sessions'
import { expandPath } from '@craft-agent/shared/utils'
import { runGit, runGitResult } from '../git'
import { commonGitDir, repoCommandDir, worktreeParentFor } from './discover'
import { branchSlug, gitReason, resolveWorktreeBase } from './worktree'

const GIT_WRITE_TIMEOUT_MS = 60_000
const MARKER_DIRECTORY = 'craft-session-worktrees'

export class OwnedWorktreeError extends Error {
  constructor(message: string, readonly code: 'invalid-plan' | 'invalid-directory' | 'not-a-repo' | 'no-commit' | 'collision' | 'not-owned' | 'git-failed') {
    super(message)
    this.name = 'OwnedWorktreeError'
  }
}

export interface PlanOwnedWorktreeInput {
  repositoryPath: string
  ownerId: string
  sessionId: string
  baseBranch?: string
}

export interface RemoveOwnedWorktreeResult {
  removed: boolean
  reason?: string
}

interface WorktreeEntry {
  path: string
  branch?: string
  locked: boolean
}

/** Serializes retries/removal for a single owner without blocking other sessions in the repo. */
const operations = new Map<string, Promise<unknown>>()

async function exclusive<T>(plan: OwnedWorktree, action: () => Promise<T>): Promise<T> {
  const key = `${plan.gitDir}\0${plan.ownerId}`
  const previous = operations.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(action)
  operations.set(key, next)
  try {
    return await next
  } finally {
    if (operations.get(key) === next) operations.delete(key)
  }
}

function ownerKey(ownerId: string): string {
  return createHash('sha256').update(ownerId).digest('hex')
}

function markerPath(plan: OwnedWorktree): string {
  return join(plan.gitDir, MARKER_DIRECTORY, `${ownerKey(plan.ownerId)}.json`)
}

function expectedPath(gitDir: string, branch: string): string {
  const name = branchSlug(branch)
  const folder = basename(gitDir) === '.git' ? `${basename(repoCommandDir(gitDir))}-${name}` : name
  return join(worktreeParentFor(gitDir), folder)
}

function isInsideDirectory(directory: string, parent: string): boolean {
  const child = relative(parent, directory)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

/** Ownership is always rooted at plan.path; the agent may start in a project subdirectory. */
export function ownedWorktreeWorkingDirectory(plan: OwnedWorktree): string {
  const subdirectory = plan.projectSubdirectory
  if (subdirectory === undefined) return plan.path
  if (typeof subdirectory !== 'string' || !subdirectory || subdirectory.includes('\0') || isAbsolute(subdirectory)) {
    throw new OwnedWorktreeError('Invalid project subdirectory in the worktree ownership record', 'invalid-plan')
  }
  const directory = resolve(plan.path, subdirectory)
  if (!isInsideDirectory(directory, plan.path) || relative(plan.path, directory) !== subdirectory) {
    throw new OwnedWorktreeError('The project subdirectory must stay inside the session worktree', 'invalid-plan')
  }
  return directory
}

/** Use the selected checkout's root, which can differ from the repository's main checkout. */
async function projectSubdirectory(repositoryPath: string, repoPath: string): Promise<string | undefined> {
  const directory = await realpath(repositoryPath)
  const topLevel = await runGit(directory, ['rev-parse', '--show-toplevel'])
  if (!topLevel) {
    if (directory === repoPath && await runGit(directory, ['rev-parse', '--is-bare-repository']) === 'true') return
    throw new OwnedWorktreeError('The project folder is not inside a Git checkout', 'not-a-repo')
  }
  const root = await realpath(topLevel)
  if (!isInsideDirectory(directory, root)) {
    throw new OwnedWorktreeError('The project folder is outside its Git checkout', 'invalid-directory')
  }
  return relative(root, directory) || undefined
}

/** Never fall back to the checkout root or follow a project directory outside its isolation. */
async function validateWorkingDirectory(plan: OwnedWorktree): Promise<void> {
  const directory = ownedWorktreeWorkingDirectory(plan)
  try {
    const actual = await realpath(directory)
    if (!isInsideDirectory(actual, plan.path) || !(await stat(actual)).isDirectory()) {
      throw new OwnedWorktreeError('The project folder is not a directory inside the session worktree', 'invalid-directory')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
      throw new OwnedWorktreeError(`The project subdirectory "${plan.projectSubdirectory ?? '.'}" is missing from the session worktree`, 'invalid-directory')
    }
    throw error
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function branchCommit(plan: OwnedWorktree): Promise<string | null> {
  return runGit(plan.repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${plan.branch}^{commit}`])
}

async function worktrees(plan: Pick<OwnedWorktree, 'repoPath'>): Promise<WorktreeEntry[]> {
  const result = await runGitResult(plan.repoPath, ['worktree', 'list', '--porcelain', '-z'])
  if (!result.ok) throw new OwnedWorktreeError(gitReason(result.stderr), 'git-failed')
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | undefined
  // NUL framing preserves repository paths containing spaces, tabs or newlines.
  for (const field of result.stdout.split('\0')) {
    if (field.startsWith('worktree ')) {
      current = { path: resolve(field.slice(9)), locked: false }
      entries.push(current)
    } else if (current && field.startsWith('branch ')) {
      current.branch = field.slice(7).replace(/^refs\/heads\//, '')
    } else if (current && (field === 'locked' || field.startsWith('locked '))) {
      current.locked = true
    }
  }
  return entries
}

async function validatePlan(plan: OwnedWorktree): Promise<void> {
  if (plan.version !== 1 || !plan.ownerId || !plan.token || !/^[a-f\d]{40,64}$/.test(plan.baseCommit)) {
    throw new OwnedWorktreeError('Invalid session worktree ownership record', 'invalid-plan')
  }
  ownedWorktreeWorkingDirectory(plan)
  const gitDir = await commonGitDir(plan.repoPath)
  if (!gitDir || gitDir !== plan.gitDir || resolve(plan.repoPath) !== repoCommandDir(gitDir)) {
    throw new OwnedWorktreeError('The session repository no longer matches its worktree record', 'not-a-repo')
  }
  if (!plan.branch.startsWith('craft/session-') || !plan.branch.endsWith(`-${ownerKey(plan.ownerId).slice(0, 16)}`)
    || plan.path !== expectedPath(gitDir, plan.branch)
    || !(await runGit(plan.repoPath, ['check-ref-format', '--branch', plan.branch]))) {
    throw new OwnedWorktreeError('The worktree path or branch is not owned by this session', 'invalid-plan')
  }
  if (await exists(plan.path)) {
    const entry = await lstat(plan.path)
    if (entry.isSymbolicLink() || !entry.isDirectory() || await realpath(plan.path) !== plan.path) {
      throw new OwnedWorktreeError('The session worktree path is not its original directory', 'not-owned')
    }
  }
}

function sameReservation(left: OwnedWorktree, right: OwnedWorktree): boolean {
  return ['version', 'ownerId', 'token', 'repoPath', 'gitDir', 'path', 'projectSubdirectory', 'branch', 'base', 'baseCommit']
    .every(key => left[key as keyof OwnedWorktree] === right[key as keyof OwnedWorktree])
}

async function readReservation(plan: OwnedWorktree): Promise<OwnedWorktree | null> {
  try {
    const stored = JSON.parse(await readFile(markerPath(plan), 'utf8')) as OwnedWorktree
    if (!stored || !sameReservation(stored, plan)) {
      throw new OwnedWorktreeError('Another session owns this worktree reservation', 'not-owned')
    }
    return stored
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof OwnedWorktreeError) throw error
    throw new OwnedWorktreeError('The worktree ownership record cannot be read', 'not-owned')
  }
}

/** Read-only planning (apart from a best-effort fetch). Persist this result before creating Git state. */
export async function planOwnedWorktree(input: PlanOwnedWorktreeInput): Promise<OwnedWorktree> {
  if (!input.ownerId || !input.sessionId) throw new OwnedWorktreeError('A worktree requires a session owner', 'invalid-plan')
  const repositoryPath = expandPath(input.repositoryPath)
  const gitDir = await commonGitDir(repositoryPath)
  if (!gitDir) throw new OwnedWorktreeError('The project folder is not a Git repository', 'not-a-repo')
  const repoPath = repoCommandDir(gitDir)
  const subdirectory = await projectSubdirectory(repositoryPath, repoPath)
  const base = await resolveWorktreeBase(repoPath, input.baseBranch)
  const baseCommit = await runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
  if (!baseCommit) throw new OwnedWorktreeError('The repository must have an initial commit', 'no-commit')
  if (subdirectory && await runGit(repoPath, ['cat-file', '-t', `${baseCommit}:${subdirectory.split(sep).join('/')}`]) !== 'tree') {
    throw new OwnedWorktreeError(`The project subdirectory "${subdirectory}" is not a directory in base branch "${input.baseBranch ?? base}"`, 'invalid-directory')
  }
  const sessionName = branchSlug(input.sessionId).slice(0, 48)
  const branch = `craft/session-${sessionName}-${ownerKey(input.ownerId).slice(0, 16)}`
  const plan: OwnedWorktree = {
    version: 1,
    ownerId: input.ownerId,
    token: randomUUID(),
    repoPath,
    gitDir,
    path: expectedPath(gitDir, branch),
    ...(subdirectory ? { projectSubdirectory: subdirectory } : {}),
    branch,
    base,
    baseCommit,
    status: 'pending',
  }
  if (await exists(plan.path) || await branchCommit(plan) || await exists(markerPath(plan))) {
    throw new OwnedWorktreeError('This session already has Git state; resume its saved worktree record', 'collision')
  }
  return plan
}

async function reserve(plan: OwnedWorktree): Promise<OwnedWorktree> {
  const existing = await readReservation(plan)
  if (existing) return existing
  // An existing branch/path without our marker belongs to someone else, even when empty or clean.
  if (await exists(plan.path) || await branchCommit(plan)
    || (await worktrees(plan)).some(entry => entry.path === plan.path || entry.branch === plan.branch)) {
    throw new OwnedWorktreeError('The worktree branch or directory already exists without session ownership', 'collision')
  }
  await mkdir(join(plan.gitDir, MARKER_DIRECTORY), { recursive: true })
  try {
    await writeFile(markerPath(plan), JSON.stringify(plan), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    // A second request for the same persisted plan is safe; a different token is not.
    return (await readReservation(plan))!
  }
  return plan
}

async function markReservation(plan: OwnedWorktree, status: OwnedWorktree['status']): Promise<OwnedWorktree> {
  const updated: OwnedWorktree = { ...plan, status }
  const target = markerPath(plan)
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(updated), { mode: 0o600 })
  await rename(temporary, target)
  return updated
}

/** Git registers a worktree before it finishes checking out files; registration alone is not ready. */
async function verifyInterruptedCheckout(plan: OwnedWorktree, reservation: OwnedWorktree): Promise<void> {
  if (reservation.status === 'ready') return
  const index = await runGit(plan.path, ['rev-parse', '--git-path', 'index'])
  const status = await runGitResult(plan.path, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])
  if (!index || !await exists(resolve(plan.path, index)) || !status.ok || status.stdout) {
    throw new OwnedWorktreeError('The interrupted worktree is incomplete or contains changes; its files were preserved', 'not-owned')
  }
}

async function existingOwnedWorktree(plan: OwnedWorktree): Promise<boolean> {
  const entries = await worktrees(plan)
  const atPath = entries.find(entry => entry.path === plan.path)
  const atBranch = entries.find(entry => entry.branch === plan.branch)
  if (atPath) {
    if (atPath.branch !== plan.branch || !await exists(plan.path) || await commonGitDir(plan.path) !== plan.gitDir) {
      throw new OwnedWorktreeError('The registered worktree no longer matches this session', 'not-owned')
    }
    return true
  }
  if (atBranch || await exists(plan.path)) {
    throw new OwnedWorktreeError('The branch or worktree directory is now used elsewhere', 'collision')
  }
  return false
}

/** Creates or resumes only the checkout named by the caller's durable, session-owned plan. */
export async function ensureOwnedWorktree(plan: OwnedWorktree): Promise<OwnedWorktree> {
  return exclusive(plan, async () => {
    await validatePlan(plan)
    const reservation = await reserve(plan)
    if (await existingOwnedWorktree(plan)) {
      await verifyInterruptedCheckout(plan, reservation)
      await validateWorkingDirectory(plan)
      return markReservation(plan, 'ready')
    }
    const commit = await branchCommit(plan)
    if (commit && plan.status === 'pending' && commit !== plan.baseCommit) {
      throw new OwnedWorktreeError('An incomplete worktree reservation points to a different commit', 'not-owned')
    }
    if (!commit && plan.status !== 'pending') {
      throw new OwnedWorktreeError('The saved session branch is missing; refusing to reset its history', 'not-owned')
    }
    const args = commit
      ? ['worktree', 'add', plan.path, plan.branch]
      : ['worktree', 'add', '-b', plan.branch, plan.path, plan.baseCommit]
    // This also covers restoration: an old ready marker cannot certify a new checkout's contents.
    await markReservation(plan, 'pending')
    const result = await runGitResult(plan.repoPath, args, GIT_WRITE_TIMEOUT_MS)
    if (!result.ok) {
      // Another request/process may have completed exactly this reserved checkout while Git waited.
      if (!await existingOwnedWorktree(plan)) {
        throw new OwnedWorktreeError(gitReason(result.stderr) || 'Could not prepare the session worktree', 'git-failed')
      }
      await verifyInterruptedCheckout(plan, (await readReservation(plan))!)
    }
    if (!await existingOwnedWorktree(plan)) throw new OwnedWorktreeError('Git did not create the session worktree', 'git-failed')
    await validateWorkingDirectory(plan)
    return markReservation(plan, 'ready')
  })
}

/** Removes a clean owned checkout, never its branch. Dirty, untracked and ignored files keep it alive. */
export async function removeOwnedWorktree(plan: OwnedWorktree): Promise<RemoveOwnedWorktreeResult> {
  return exclusive(plan, async () => {
    await validatePlan(plan)
    if (!await readReservation(plan)) {
      return { removed: false, reason: 'The worktree has no session ownership record' }
    }
    if (!await existingOwnedWorktree(plan)) {
      return { removed: true }
    }
    const entry = (await worktrees(plan)).find(candidate => candidate.path === plan.path)!
    if (entry.locked) return { removed: false, reason: 'The worktree is locked' }
    // Both status and worktree remove trust these bits and can miss modified tracked files.
    const tracked = await runGitResult(plan.path, ['ls-files', '-v', '-z'])
    if (!tracked.ok) return { removed: false, reason: gitReason(tracked.stderr) || 'Could not inspect the worktree index' }
    if (tracked.stdout.split('\0').some(file => /^[a-zS] /.test(file))) {
      return { removed: false, reason: 'The worktree has assume-unchanged or skip-worktree files that Git status can hide' }
    }
    const status = await runGitResult(plan.path, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'])
    if (!status.ok) return { removed: false, reason: gitReason(status.stderr) || 'Could not inspect the worktree' }
    if (status.stdout) return { removed: false, reason: 'The worktree contains changes, untracked files, or ignored files' }
    const result = await runGitResult(plan.repoPath, ['worktree', 'remove', plan.path], GIT_WRITE_TIMEOUT_MS)
    if (!result.ok) return { removed: false, reason: gitReason(result.stderr) || 'Could not remove the worktree' }
    return { removed: true }
  })
}
