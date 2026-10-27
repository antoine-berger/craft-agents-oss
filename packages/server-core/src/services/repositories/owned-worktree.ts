/**
 * Session-owned worktrees. The caller persists the plan before ensureOwnedWorktree so a retry or
 * restart uses the same branch and directory. A marker in the common Git directory records the
 * reservation before Git is called; merely finding a similarly named branch never establishes
 * ownership. Removal keeps the branch and refuses tracked, untracked AND ignored local files.
 */

import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { OwnedWorktree } from '@craft-agent/shared/sessions'
import { expandPath } from '@craft-agent/shared/utils'
import { runGit, runGitResult } from '../git'
import { commonGitDir, repoCommandDir, worktreeParentFor } from './discover'
import { branchSlug, gitReason, resolveWorktreeBase } from './worktree'
import { isValidGitHubLogin } from './github'

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
  branchPrefix?: string
  baseBranch?: string
  /** Human task title or first user message. New branches use its descriptive slug. */
  taskTitle?: string
  /** Reuse this exact local branch if it is not checked out anywhere else. */
  existingBranch?: string
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

async function exclusive<T>(plan: Pick<OwnedWorktree, 'gitDir' | 'ownerId'>, action: () => Promise<T>): Promise<T> {
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

function expectedPath(gitDir: string, branch: string, ownerId?: string): string {
  const name = branchSlug(branch) + (ownerId ? `-${ownerKey(ownerId).slice(0, 8)}` : '')
  const folder = basename(gitDir) === '.git' ? `${basename(repoCommandDir(gitDir))}-${name}` : name
  return join(worktreeParentFor(gitDir), folder)
}

/** Only names appear in Git; the durable ownership digest stays in private metadata/path. */
export function taskBranchSlug(title: string): string {
  const slug = title.replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ' ')
    .replace(/(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]+|[A-Za-z0-9_-]{28,})/g, 'reference')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.slice(0, 72).replace(/-+$/g, '') || 'task'
}
function allocationPath(plan: Pick<OwnedWorktree, 'gitDir' | 'branch'>): string {
  return join(plan.gitDir, MARKER_DIRECTORY, 'branches', createHash('sha256').update(plan.branch).digest('hex') + '.json')
}

/** Publish complete JSON atomically, without replacing an existing reservation. */
async function writeExclusivePlan(path: string, plan: OwnedWorktree): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(plan), { flag: 'wx', mode: 0o600 })
  try { await link(temporary, path) } finally { await unlink(temporary) }
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
  const prefix = plan.branchPrefix ?? 'craft'
  const named = plan.branchNaming === 'task' || plan.branchNaming === 'existing'
  const validName = named
    ? (plan.branchNaming === 'existing' || plan.branch.startsWith(`${prefix}/`))
    : plan.branch.startsWith(`${prefix}/session-`) && plan.branch.endsWith(`-${ownerKey(plan.ownerId).slice(0, 16)}`)
  if ((plan.branchPrefix !== undefined && !isValidGitHubLogin(plan.branchPrefix))
    || (plan.branchNaming !== undefined && !named) || !validName
    || plan.path !== expectedPath(gitDir, plan.branch, named ? plan.ownerId : undefined)
    || !(await runGit(plan.repoPath, ['check-ref-format', '--branch', plan.branch]))) {
    throw new OwnedWorktreeError('The worktree path or branch is not owned by this session', 'invalid-plan')
  }
  if (named) {
    try {
      const allocated = JSON.parse(await readFile(allocationPath(plan), 'utf8')) as OwnedWorktree
      if (!sameReservation(allocated, plan)) throw new Error('different owner')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // A cleaned checkout releases its branch lease, but retains its owner journal.
        // It may be restored only when no other checkout/session has taken that branch.
        const journal = await readReservation(plan)
        const busy = (await worktrees(plan)).some(entry => entry.branch === plan.branch && entry.path !== plan.path)
        if (!journal || busy) throw new OwnedWorktreeError('The branch is now used by another checkout', 'not-owned')
        try { await writeExclusivePlan(allocationPath(plan), plan) }
        catch { throw new OwnedWorktreeError('Another session now owns this branch checkout', 'not-owned') }
      } else {
        throw new OwnedWorktreeError('The branch has no matching durable session allocation', 'not-owned')
      }
    }
  }
  if (await exists(plan.path)) {
    const entry = await lstat(plan.path)
    if (entry.isSymbolicLink() || !entry.isDirectory() || await realpath(plan.path) !== plan.path) {
      throw new OwnedWorktreeError('The session worktree path is not its original directory', 'not-owned')
    }
  }
}

function sameReservation(left: OwnedWorktree, right: OwnedWorktree): boolean {
  return ['version', 'ownerId', 'token', 'repoPath', 'gitDir', 'path', 'projectSubdirectory', 'branchPrefix', 'branchNaming', 'branch', 'base', 'baseCommit']
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

/** Plan before Git checkout. Named branches atomically reserve private metadata for crash-safe allocation. */
export async function planOwnedWorktree(input: PlanOwnedWorktreeInput): Promise<OwnedWorktree> {
  if (!input.ownerId || !input.sessionId) throw new OwnedWorktreeError('A worktree requires a session owner', 'invalid-plan')
  if (input.branchPrefix !== undefined && !isValidGitHubLogin(input.branchPrefix)) {
    throw new OwnedWorktreeError('Invalid GitHub username for the session branch', 'invalid-plan')
  }
  const repositoryPath = expandPath(input.repositoryPath)
  const gitDir = await commonGitDir(repositoryPath)
  if (!gitDir) throw new OwnedWorktreeError('The project folder is not a Git repository', 'not-a-repo')
  const repoPath = repoCommandDir(gitDir)
  const subdirectory = await projectSubdirectory(repositoryPath, repoPath)
  if (input.taskTitle || input.existingBranch) {
    return exclusive({ gitDir, ownerId: input.ownerId }, async () => {
      const previous = join(gitDir, MARKER_DIRECTORY, `${ownerKey(input.ownerId)}.json`)
      if (await exists(previous)) {
        const saved = JSON.parse(await readFile(previous, 'utf8')) as OwnedWorktree
        if (saved.ownerId !== input.ownerId || saved.gitDir !== gitDir || !saved.branchNaming) throw new OwnedWorktreeError('This session already has a different worktree reservation', 'collision')
        await validatePlan(saved)
        return saved
      }
      const base = await resolveWorktreeBase(repoPath, input.baseBranch)
      if (input.existingBranch && (input.existingBranch.startsWith('-') || !await runGit(repoPath, ['check-ref-format', '--branch', input.existingBranch]))) throw new OwnedWorktreeError('Invalid existing branch', 'invalid-plan')
      const commitRef = input.existingBranch ? `refs/heads/${input.existingBranch}` : base
      const baseCommit = await runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${commitRef}^{commit}`])
      if (!baseCommit) throw new OwnedWorktreeError('The selected branch must exist and contain a commit', 'no-commit')
      if (subdirectory && await runGit(repoPath, ['cat-file', '-t', `${baseCommit}:${subdirectory.split(sep).join('/')}`]) !== 'tree') throw new OwnedWorktreeError('The project directory does not exist in the selected branch', 'invalid-directory')
      const entries = await worktrees({ repoPath })
      if (input.existingBranch && entries.some(entry => entry.branch === input.existingBranch)) throw new OwnedWorktreeError(`Branch "${input.existingBranch}" is already checked out. Choose a new branch copy instead.`, 'collision')
      const initial = input.existingBranch ?? `${input.branchPrefix ?? 'craft'}/${taskBranchSlug(input.taskTitle ?? input.sessionId)}`
      await mkdir(join(gitDir, MARKER_DIRECTORY, 'branches'), { recursive: true })
      for (let number = 1; number <= 1000; number++) {
        const branch = number === 1 ? initial : `${initial}-${number}`
        const plan: OwnedWorktree = {
          version: 1, ownerId: input.ownerId, token: randomUUID(), repoPath, gitDir,
          branchPrefix: input.branchPrefix, branchNaming: input.existingBranch ? 'existing' : 'task',
          branch, path: expectedPath(gitDir, branch, input.ownerId), base, baseCommit,
          ...(subdirectory ? { projectSubdirectory: subdirectory } : {}), status: 'pending',
        }
        if (await exists(plan.path) || (!input.existingBranch && await branchCommit(plan))) continue
        let allocated = false
        try {
          await writeExclusivePlan(allocationPath(plan), plan)
          allocated = true
          await writeExclusivePlan(markerPath(plan), plan)
          return plan
        } catch (error) {
          if (allocated) await unlink(allocationPath(plan))
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          // Recover another process's durable allocation for the same session owner.
          const recoveryFile = allocated ? markerPath(plan) : allocationPath(plan)
          const recovery = JSON.parse(await readFile(recoveryFile, 'utf8')) as OwnedWorktree
          if (recovery.ownerId === input.ownerId && recovery.gitDir === gitDir && recovery.branchNaming) {
            await validatePlan(recovery)
            if (!await exists(markerPath(recovery))) {
              try { await writeExclusivePlan(markerPath(recovery), recovery) }
              catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError }
            }
            return recovery
          }
          if (input.existingBranch) throw new OwnedWorktreeError('Another session already owns this branch checkout', 'collision')
        }
      }
      throw new OwnedWorktreeError('No available task branch name', 'collision')
    })
  }
  const base = await resolveWorktreeBase(repoPath, input.baseBranch)
  const baseCommit = await runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
  if (!baseCommit) throw new OwnedWorktreeError('The repository must have an initial commit', 'no-commit')
  if (subdirectory && await runGit(repoPath, ['cat-file', '-t', `${baseCommit}:${subdirectory.split(sep).join('/')}`]) !== 'tree') {
    throw new OwnedWorktreeError(`The project subdirectory "${subdirectory}" is not a directory in base branch "${input.baseBranch ?? base}"`, 'invalid-directory')
  }
  const sessionName = branchSlug(input.sessionId).slice(0, 48)
  const branch = `${input.branchPrefix ?? 'craft'}/session-${sessionName}-${ownerKey(input.ownerId).slice(0, 16)}`
  const plan: OwnedWorktree = {
    version: 1,
    ownerId: input.ownerId,
    ...(input.branchPrefix ? { branchPrefix: input.branchPrefix } : {}),
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
    await writeExclusivePlan(markerPath(plan), plan)
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
  await writeFile(temporary, JSON.stringify({ ...updated, ...(plan.branchNaming && status === 'pending' ? { checkoutStarted: true } : {}) }), { mode: 0o600 })
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
    if (commit && plan.branchNaming === 'task' && reservation.status === 'pending' && !(reservation as OwnedWorktree & { checkoutStarted?: boolean }).checkoutStarted) {
      throw new OwnedWorktreeError('The planned branch was created outside this session; its history was preserved', 'collision')
    }
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

async function releaseBranchAllocation(plan: OwnedWorktree): Promise<void> {
  if (!plan.branchNaming) return
  try {
    const allocated = JSON.parse(await readFile(allocationPath(plan), 'utf8')) as OwnedWorktree
    if (sameReservation(allocated, plan)) await unlink(allocationPath(plan))
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}

/** Removes a clean owned checkout, never its branch. Dirty, untracked and ignored files keep it alive. */
export async function removeOwnedWorktree(plan: OwnedWorktree): Promise<RemoveOwnedWorktreeResult> {
  return exclusive(plan, async () => {
    await validatePlan(plan)
    if (!await readReservation(plan)) {
      return { removed: false, reason: 'The worktree has no session ownership record' }
    }
    if (!await existingOwnedWorktree(plan)) {
      await releaseBranchAllocation(plan)
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
    await releaseBranchAllocation(plan)
    return { removed: true }
  })
}
