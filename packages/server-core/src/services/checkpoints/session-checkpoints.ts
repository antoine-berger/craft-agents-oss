/**
 * Private Git snapshots for session-owned worktrees. A separate index captures tracked and
 * non-ignored untracked files without changing the user's index, branch or stash. Restoring first
 * persists a verified recovery snapshot and conversation copy. Ignored files are never copied or
 * removed; a restore which would overwrite one is refused.
 */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { OwnedWorktree } from '@craft-agent/shared/sessions'
import type { SessionCheckpointList, SessionCheckpointRestoreResult, SessionCheckpointSummary } from '@craft-agent/shared/protocol/checkpoints'

const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_BYTES = 128 * 1024 * 1024
const MAX_FILES = 20_000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const locks = new Map<string, Promise<unknown>>()

export class SessionCheckpointError extends Error {
  constructor(message: string, readonly code: 'not-owned' | 'busy' | 'unsupported' | 'too-large' | 'invalid-checkpoint' | 'git-failed' | 'recovery-needed') {
    super(message)
    this.name = 'SessionCheckpointError'
  }
}

export interface CheckpointContext {
  plan: OwnedWorktree
  sessionDir: string
  /** Limits apply to new/modified files, not unchanged blobs already stored in Git. */
  limits?: { maxFileBytes?: number; maxChangedBytes?: number; maxChangedFiles?: number }
}

export interface CheckpointRecord extends SessionCheckpointSummary {
  version: 1
  ownerId: string
  repoPath: string
  gitDir: string
  worktreePath: string
  snapshotCommit: string
  snapshotRef: string
  indexPresent: boolean
  indexHash?: string
  conversationHash?: string
}

export interface RestoreCheckpointInput extends CheckpointContext {
  checkpointId: string
  /** Must reject active turns AND background writers in any session sharing this checkout. */
  assertIdle: () => Promise<void> | void
  /** Persist truncated conversation (turn) or the saved full conversation (recovery). Clear SDK/fork IDs. */
  restoreConversation: (target: CheckpointRecord, recovery: CheckpointRecord) => Promise<void>
  /** Reload the copied pre-restore JSONL/in-memory fields if restoring the conversation fails. */
  rollbackConversation: (recovery: CheckpointRecord) => Promise<void>
}

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const recordDir = (sessionDir: string, id: string) => join(sessionDir, 'checkpoints', id)
const summary = ({ id, kind, userMessageId, createdAt, branch, headCommit }: CheckpointRecord): SessionCheckpointSummary =>
  ({ id, kind, ...(userMessageId ? { userMessageId } : {}), createdAt, branch, headCommit })
const validId = (id: string) => /^[a-f0-9]{32}$/.test(id)

async function exclusive<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(path) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(action)
  locks.set(path, operation)
  try { return await operation } finally { if (locks.get(path) === operation) locks.delete(path) }
}

async function git(cwd: string, args: string[], indexFile?: string): Promise<string> {
  return new Promise((done, reject) => {
    execFile('git', ['-C', cwd, '-c', 'core.fsmonitor=false', '-c', 'core.fsync=all', ...args], {
      timeout: 60_000, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true,
      env: { ...process.env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
        GIT_AUTHOR_NAME: 'Craft Checkpoints', GIT_AUTHOR_EMAIL: 'checkpoints@craft.invalid',
        GIT_COMMITTER_NAME: 'Craft Checkpoints', GIT_COMMITTER_EMAIL: 'checkpoints@craft.invalid' },
    }, (error, stdout, stderr) => error
      ? reject(new SessionCheckpointError(String(stderr).trim() || 'Git checkpoint operation failed', 'git-failed'))
      : done(stdout))
  })
}

function safePath(path: string, root: string): string {
  if (!path || path.includes('\0') || path.includes('�') || isAbsolute(path)) throw new SessionCheckpointError('Invalid file path in checkpoint', 'invalid-checkpoint')
  const absolute = resolve(root, path)
  const child = relative(root, absolute)
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new SessionCheckpointError('Checkpoint path escapes its worktree', 'invalid-checkpoint')
  return absolute
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function durableWrite(path: string, data: string | Buffer): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
}

async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  await durableWrite(temporary, data)
  await rename(temporary, path)
  await syncDirectory(dirname(path))
}

/** Validate the durable ownership marker, not just a similarly named checkout. */
async function assertOwned(context: CheckpointContext): Promise<void> {
  const { plan } = context
  const storage = await realpath(context.sessionDir).catch(() => resolve(context.sessionDir))
  const storageRelative = relative(plan.path, storage)
  if (storageRelative === '' || (storageRelative !== '..' && !storageRelative.startsWith(`..${sep}`) && !isAbsolute(storageRelative))) {
    throw new SessionCheckpointError('Checkpoint storage must be outside its working checkout', 'unsupported')
  }
  if (plan.status !== 'ready' || !plan.ownerId || !plan.token) throw new SessionCheckpointError('A ready session-owned worktree is required', 'not-owned')
  if (await realpath(plan.path).catch(() => '') !== plan.path || await realpath(plan.gitDir).catch(() => '') !== plan.gitDir) throw new SessionCheckpointError('The original worktree is no longer available', 'not-owned')
  const [top, common, branch] = await Promise.all([
    git(plan.path, ['rev-parse', '--show-toplevel']), git(plan.path, ['rev-parse', '--git-common-dir']),
    git(plan.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
  ])
  const markerFile = join(plan.gitDir, 'craft-session-worktrees', `${hash(plan.ownerId)}.json`)
  let marker: OwnedWorktree
  try { marker = JSON.parse(await readFile(markerFile, 'utf8')) } catch { throw new SessionCheckpointError('The worktree ownership reservation is missing', 'not-owned') }
  if (resolve(top.trim()) !== plan.path || resolve(plan.path, common.trim()) !== plan.gitDir || branch.trim() !== plan.branch
    || marker.ownerId !== plan.ownerId || marker.token !== plan.token || marker.path !== plan.path || marker.branch !== plan.branch) {
    throw new SessionCheckpointError('This checkout does not match the session-owned worktree', 'not-owned')
  }
  const stages = await git(plan.path, ['ls-files', '--stage', '-z'])
  if (stages.split('\0').some(entry => entry.startsWith('160000 '))) throw new SessionCheckpointError('Checkpoints for repositories with submodules are not supported yet; files were preserved', 'unsupported')
  const flags = await git(plan.path, ['ls-files', '-v', '-z'])
  if (flags.split('\0').some(entry => /^[a-zS] /.test(entry))) throw new SessionCheckpointError('Clear assume-unchanged/skip-worktree flags before using checkpoints', 'unsupported')
}

async function workingFiles({ plan, limits }: CheckpointContext): Promise<string[]> {
  const [changed, untracked] = await Promise.all([
    git(plan.path, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--']),
    git(plan.path, ['ls-files', '--others', '--exclude-standard', '-z']),
  ])
  const files = [...new Set([...changed.split('\0'), ...untracked.split('\0')].filter(Boolean))]
  const maxFiles = limits?.maxChangedFiles ?? MAX_FILES
  const maxFileBytes = limits?.maxFileBytes ?? MAX_FILE_BYTES
  const maxChangedBytes = limits?.maxChangedBytes ?? MAX_TOTAL_BYTES
  if (files.length > maxFiles) throw new SessionCheckpointError('Too many changed files for a checkpoint', 'too-large')
  let total = 0
  for (const file of files) {
    const path = safePath(file, plan.path)
    const info = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null
      throw error
    })
    if (!info) continue // Tracked deletions are represented by git add -A.
    if (!info.isFile() && !info.isSymbolicLink()) throw new SessionCheckpointError('Unsupported file type in the worktree', 'unsupported')
    if (info.size > maxFileBytes || (total += info.size) > maxChangedBytes) throw new SessionCheckpointError(`Changed files exceed checkpoint limits (${Math.round(maxFileBytes / 1024 / 1024)} MiB per file / ${Math.round(maxChangedBytes / 1024 / 1024)} MiB changed total); files were preserved`, 'too-large')
  }
  return files
}

async function indexPath(plan: OwnedWorktree): Promise<string> {
  return resolve(plan.path, (await git(plan.path, ['rev-parse', '--git-path', 'index'])).trim())
}

async function withIndexLock<T>(plan: OwnedWorktree, action: () => Promise<T>): Promise<T> {
  const lockPath = `${await indexPath(plan)}.lock`
  let handle
  try { handle = await open(lockPath, 'wx', 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SessionCheckpointError('Another Git operation is using this checkout; retry when it finishes.', 'busy')
    throw error
  }
  try { return await action() } finally { await handle.close(); await rm(lockPath, { force: true }) }
}

async function loadRecord(context: CheckpointContext, id: string): Promise<CheckpointRecord> {
  if (!validId(id)) throw new SessionCheckpointError('Invalid checkpoint identifier', 'invalid-checkpoint')
  let record: CheckpointRecord
  try { record = JSON.parse(await readFile(join(recordDir(context.sessionDir, id), 'record.json'), 'utf8')) } catch { throw new SessionCheckpointError('Checkpoint record is unavailable', 'invalid-checkpoint') }
  if (record.version !== 1 || record.id !== id || !['turn', 'recovery'].includes(record.kind)
    || record.ownerId !== context.plan.ownerId || record.worktreePath !== context.plan.path || record.gitDir !== context.plan.gitDir
    || record.branch !== context.plan.branch || !/^[a-f0-9]{40,64}$/.test(record.headCommit) || !/^[a-f0-9]{40,64}$/.test(record.snapshotCommit)) {
    throw new SessionCheckpointError('Checkpoint ownership or contents do not match this session', 'invalid-checkpoint')
  }
  const expectedRef = `refs/craft/checkpoints/${hash(record.ownerId)}/${record.id}`
  if (record.snapshotRef !== expectedRef || (await git(context.plan.path, ['rev-parse', '--verify', record.snapshotRef])).trim() !== record.snapshotCommit) throw new SessionCheckpointError('Checkpoint Git reference no longer matches its record', 'invalid-checkpoint')
  const directory = recordDir(context.sessionDir, id)
  if (record.indexPresent && hash(await readFile(join(directory, 'index'))) !== record.indexHash) throw new SessionCheckpointError('The saved index is damaged', 'invalid-checkpoint')
  if (hash(await readFile(join(directory, 'session.jsonl'))) !== record.conversationHash) throw new SessionCheckpointError('The saved conversation is damaged', 'invalid-checkpoint')
  return record
}

async function createSnapshot(context: CheckpointContext, kind: 'turn' | 'recovery', userMessageId?: string): Promise<CheckpointRecord> {
  const { plan, sessionDir } = context
  await assertOwned(context)
  const id = kind === 'turn' ? hash(`${plan.ownerId}\0${userMessageId}`).slice(0, 32) : randomUUID().replaceAll('-', '')
  const directory = recordDir(sessionDir, id)
  if (existsSync(join(directory, 'record.json'))) return loadRecord(context, id)
  await workingFiles(context)
  const temporary = `${directory}.${randomUUID()}.tmp`
  await mkdir(temporary, { recursive: true, mode: 0o700 })
  const temporaryIndex = join(temporary, 'snapshot-index')
  try {
    const headCommit = (await git(plan.path, ['rev-parse', '--verify', 'HEAD'])).trim()
    const sourceIndex = await indexPath(plan)
    const indexPresent = existsSync(sourceIndex)
    const index = indexPresent ? await readFile(sourceIndex) : undefined
    if (index) await durableWrite(join(temporary, 'index'), index)
    await git(plan.path, ['read-tree', headCommit], temporaryIndex)
    await git(plan.path, ['add', '-A', '--', '.'], temporaryIndex)
    const tree = (await git(plan.path, ['write-tree'], temporaryIndex)).trim()
    const snapshotCommit = (await git(plan.path, ['commit-tree', tree, '-p', headCommit, '-m', `Craft ${kind} checkpoint`])).trim()
    // This private ref is outside refs/heads and never changes the user's branch/stash.
    const snapshotRef = `refs/craft/checkpoints/${hash(plan.ownerId)}/${id}`
    const record: CheckpointRecord = {
      version: 1, id, kind, ...(userMessageId ? { userMessageId } : {}), createdAt: Date.now(),
      ownerId: plan.ownerId, repoPath: plan.repoPath, gitDir: plan.gitDir, worktreePath: plan.path,
      branch: plan.branch, headCommit, snapshotCommit, snapshotRef,
      indexPresent, ...(index ? { indexHash: hash(index) } : {}),
    }
    const conversation = await readFile(join(sessionDir, 'session.jsonl'))
    await durableWrite(join(temporary, 'session.jsonl'), conversation)
    record.conversationHash = hash(conversation)
    await durableWrite(join(temporary, 'record.json'), JSON.stringify(record, null, 2))
    await git(plan.path, ['update-ref', snapshotRef, snapshotCommit, '0'.repeat(snapshotCommit.length)])
    await rm(temporaryIndex, { force: true })
    await syncDirectory(temporary)
    await rename(temporary, directory)
    await syncDirectory(dirname(directory))
    return await loadRecord(context, id) // Verify before the turn or destructive restore may proceed.
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

export async function captureSessionCheckpoint(context: CheckpointContext, userMessageId: string): Promise<SessionCheckpointSummary> {
  if (!userMessageId || userMessageId.includes('\0')) throw new SessionCheckpointError('A checkpoint requires the first message of its turn', 'invalid-checkpoint')
  return exclusive(context.plan.path, async () => {
    await assertCheckpointRestoreComplete(context)
    return withIndexLock(context.plan, async () => summary(await createSnapshot(context, 'turn', userMessageId)))
  })
}

export async function listSessionCheckpoints(context: CheckpointContext): Promise<SessionCheckpointList> {
  try { await assertOwned(context) } catch (error) { return { supported: false, reason: error instanceof Error ? error.message : String(error), checkpoints: [] } }
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(join(context.sessionDir, 'checkpoints'), { withFileTypes: true }).catch(() => [])
  const checkpoints: SessionCheckpointSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !validId(entry.name)) continue
    try { checkpoints.push(summary(await loadRecord(context, entry.name))) } catch { /* Damaged snapshots are never offered as restorable. */ }
  }
  return { supported: true, checkpoints: checkpoints.sort((a, b) => b.createdAt - a.createdAt) }
}

async function unfinishedRestores(context: CheckpointContext): Promise<Array<{ path: string; journal: Record<string, unknown> }>> {
  const { readdir } = await import('node:fs/promises')
  const directory = join(context.sessionDir, 'checkpoints')
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const pending: Array<{ path: string; journal: Record<string, unknown> }> = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !validId(entry.name)) continue
    const path = join(directory, entry.name, 'restore-journal.json')
    if (!existsSync(path)) continue
    let journal: Record<string, unknown>
    try { journal = JSON.parse(await readFile(path, 'utf8')) } catch {
      throw new SessionCheckpointError('A restore journal is damaged. Recover a verified backup before continuing this chat.', 'recovery-needed')
    }
    if (['prepared', 'files-restored', 'recovery-needed'].includes(String(journal.state))) pending.push({ path, journal })
  }
  return pending
}

/** Call before starting/resuming an SDK as well as before capture after a server restart. */
export async function assertCheckpointRestoreComplete(context: CheckpointContext): Promise<void> {
  const pending = await unfinishedRestores(context)
  if (pending.length) throw new SessionCheckpointError('An earlier restore was interrupted. Recover its saved pre-restore checkpoint before continuing this chat.', 'recovery-needed')
}

async function assertIgnoredSafe(context: CheckpointContext, target: CheckpointRecord): Promise<void> {
  const ignored = (await git(context.plan.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])).split('\0').filter(Boolean).map(path => path.replace(/\/$/, ''))
  if (!ignored.length) return
  const targetFiles = (await git(context.plan.path, ['ls-tree', '-r', '--name-only', '-z', target.snapshotCommit])).split('\0').filter(Boolean)
  for (const file of targetFiles) {
    if (ignored.some(protectedPath => file === protectedPath || file.startsWith(`${protectedPath}/`) || protectedPath.startsWith(`${file}/`))) {
      throw new SessionCheckpointError('Restoring this checkpoint would overwrite an ignored file; files were preserved', 'unsupported')
    }
  }
}

async function restoreGit(context: CheckpointContext, target: CheckpointRecord, current: CheckpointRecord): Promise<void> {
  await assertIgnoredSafe(context, target)
  const temporaryIndex = join(recordDir(context.sessionDir, current.id), `restore-index-${randomUUID()}`)
  try {
    // Starting from the full current snapshot also removes new non-ignored untracked files.
    await git(context.plan.path, ['read-tree', current.snapshotCommit], temporaryIndex)
    await git(context.plan.path, ['read-tree', '--reset', '-u', target.snapshotCommit], temporaryIndex)
    await git(context.plan.path, ['update-ref', `refs/heads/${target.branch}`, target.headCommit, current.headCommit])
    const destination = await indexPath(context.plan)
    if (target.indexPresent) await atomicWrite(destination, await readFile(join(recordDir(context.sessionDir, target.id), 'index')))
    else await rm(destination, { force: true })
  } finally { await rm(temporaryIndex, { force: true }) }
}

/** Raw server-only JSONL backup path. Copy back before parsing portable session paths. */
export function checkpointConversationPath(sessionDir: string, record: CheckpointRecord): string {
  if (!validId(record.id)) throw new SessionCheckpointError('Invalid checkpoint identifier', 'invalid-checkpoint')
  return join(recordDir(sessionDir, record.id), 'session.jsonl')
}

export async function restoreSessionCheckpoint(input: RestoreCheckpointInput): Promise<SessionCheckpointRestoreResult> {
  return exclusive(input.plan.path, async () => withIndexLock(input.plan, async () => {
    await input.assertIdle()
    await assertOwned(input)
    const target = await loadRecord(input, input.checkpointId)
    const pendingRestores = await unfinishedRestores(input)
    if (pendingRestores.length && target.kind !== 'recovery') throw new SessionCheckpointError('Recover the saved pre-restore checkpoint before selecting another turn.', 'recovery-needed')
    if (target.kind === 'turn') {
      const lines = (await readFile(checkpointConversationPath(input.sessionDir, target), 'utf8')).split('\n').filter(Boolean)
      if (!lines.slice(1).some(line => { try { const message = JSON.parse(line); return message.id === target.userMessageId && (message.type === 'user' || message.role === 'user') } catch { return false } })) {
        throw new SessionCheckpointError('The checkpoint turn no longer exists in the conversation', 'invalid-checkpoint')
      }
    }
    await assertIgnoredSafe(input, target)
    const recovery = await createSnapshot(input, 'recovery')
    const journal = join(recordDir(input.sessionDir, recovery.id), 'restore-journal.json')
    await atomicWrite(journal, JSON.stringify({ version: 1, state: 'prepared', targetId: target.id, recoveryId: recovery.id }))
    await input.assertIdle()
    await assertOwned(input)
    try {
      await restoreGit(input, target, recovery)
      await atomicWrite(journal, JSON.stringify({ version: 1, state: 'files-restored', targetId: target.id, recoveryId: recovery.id }))
      await atomicWrite(join(input.sessionDir, 'session.jsonl'), await readFile(checkpointConversationPath(input.sessionDir, target)))
      await input.restoreConversation(target, recovery)
      await atomicWrite(journal, JSON.stringify({ version: 1, state: 'complete', targetId: target.id, recoveryId: recovery.id }))
      for (const pending of pendingRestores) await atomicWrite(pending.path, JSON.stringify({ ...pending.journal, state: 'recovered', recoveredBy: recovery.id }))
      return { restored: summary(target), recovery: summary(recovery) }
    } catch (error) {
      try {
        // The branch may or may not have advanced when materialization failed.
        const head = (await git(input.plan.path, ['rev-parse', 'HEAD'])).trim()
        await restoreGit(input, recovery, { ...target, headCommit: head })
        await atomicWrite(join(input.sessionDir, 'session.jsonl'), await readFile(checkpointConversationPath(input.sessionDir, recovery)))
        await input.rollbackConversation(recovery)
        await atomicWrite(journal, JSON.stringify({ version: 1, state: 'rolled-back', targetId: target.id, recoveryId: recovery.id }))
      } catch {
        await atomicWrite(journal, JSON.stringify({ version: 1, state: 'recovery-needed', targetId: target.id, recoveryId: recovery.id }))
        throw new SessionCheckpointError(`Restore interrupted. The verified pre-restore backup is ${recovery.id}; recover it before continuing this chat.`, 'recovery-needed')
      }
      throw error
    }
  }))
}
