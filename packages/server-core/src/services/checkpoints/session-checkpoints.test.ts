import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OwnedWorktree } from '@craft-agent/shared/sessions'
import { ensureOwnedWorktree, planOwnedWorktree } from '../repositories/owned-worktree'
import { captureSessionCheckpoint, checkpointConversationPath, listSessionCheckpoints, restoreSessionCheckpoint, assertCheckpointRestoreComplete, SessionCheckpointError } from './session-checkpoints'

let root: string, repo: string, sessionDir: string, plan: OwnedWorktree
const env = { ...process.env, GIT_AUTHOR_NAME: 'Checkpoint Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Checkpoint Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const jsonl = (messages: Array<{ id: string; type: string; content: string }>) => [{ id: 'session-one' }, ...messages].map(item => JSON.stringify(item)).join('\n') + '\n'
const context = () => ({ plan, sessionDir })
const recordFile = () => join(sessionDir, 'session.jsonl')
const user = { id: 'turn-one', type: 'user', content: 'Change the code' }
const idle = async () => {}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'craft-checkpoint-')))
  repo = join(root, 'repo'); mkdirSync(repo)
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Checkpoint Test'); git(repo, 'config', 'user.email', 'test@example.invalid')
  writeFileSync(join(repo, 'code.txt'), 'base\n'); writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules/\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Initial')
  plan = await ensureOwnedWorktree(await planOwnedWorktree({ repositoryPath: repo, ownerId: 'workspace/session-one', sessionId: 'session-one', baseBranch: 'main' }))
  sessionDir = join(root, 'sessions', 'session-one'); mkdirSync(sessionDir, { recursive: true })
  writeFileSync(recordFile(), jsonl([user]))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function restore(checkpointId: string, apply = async () => { writeFileSync(recordFile(), jsonl([])) }) {
  return restoreSessionCheckpoint({ ...context(), checkpointId, assertIdle: idle, restoreConversation: apply, rollbackConversation: idle })
}

describe('session turn checkpoints on real Git worktrees', () => {
  it('does not count unchanged monorepo files against changed-file limits', async () => {
    writeFileSync(join(plan.path, 'baseline.bin'), Buffer.alloc(1024 * 1024))
    git(plan.path, 'add', 'baseline.bin'); git(plan.path, 'commit', '-m', 'Existing large baseline')
    const tinyLimits = { maxFileBytes: 16, maxChangedBytes: 32, maxChangedFiles: 2 }
    expect((await captureSessionCheckpoint({ ...context(), limits: tinyLimits }, user.id)).kind).toBe('turn')
    writeFileSync(join(plan.path, 'new.bin'), Buffer.alloc(64))
    // A retry of a persisted turn never overwrites or revalidates against later changes.
    expect((await captureSessionCheckpoint({ ...context(), limits: tinyLimits }, user.id)).kind).toBe('turn')
    await expect(captureSessionCheckpoint({ ...context(), limits: tinyLimits }, 'later-turn')).rejects.toThrow('checkpoint limits')
  })

  it('blocks continuation after an interrupted restore and makes the recovery checkpoint usable', async () => {
    const checkpoint = await captureSessionCheckpoint(context(), user.id)
    writeFileSync(recordFile(), jsonl([user])); writeFileSync(join(plan.path, 'code.txt'), 'after turn\n')
    const result = await restore(checkpoint.id)
    const journal = join(sessionDir, 'checkpoints', result.recovery.id, 'restore-journal.json')
    writeFileSync(journal, JSON.stringify({ state: 'files-restored', recoveryId: result.recovery.id, targetId: checkpoint.id }))
    await expect(assertCheckpointRestoreComplete(context())).rejects.toThrow('interrupted')
    await expect(captureSessionCheckpoint(context(), 'later-turn')).rejects.toThrow('interrupted')
    await restoreSessionCheckpoint({ ...context(), checkpointId: result.recovery.id, assertIdle: idle,
      restoreConversation: async target => { writeFileSync(recordFile(), readFileSync(checkpointConversationPath(sessionDir, target))) }, rollbackConversation: idle })
    expect(readFileSync(join(plan.path, 'code.txt'), 'utf8')).toBe('after turn\n')
    await assertCheckpointRestoreComplete(context())
  })

  it('captures staged/unstaged/untracked files without changing branch, index or stash; retries reuse the original', async () => {
    writeFileSync(join(plan.path, 'code.txt'), 'staged\n'); git(plan.path, 'add', 'code.txt')
    writeFileSync(join(plan.path, 'code.txt'), 'unstaged\n'); writeFileSync(join(plan.path, 'new file.txt'), 'new\n')
    const beforeHead = git(plan.path, 'rev-parse', 'HEAD'), beforeIndex = git(plan.path, 'write-tree'), beforeStatus = git(plan.path, 'status', '--porcelain=v1')
    const checkpoint = await captureSessionCheckpoint(context(), user.id)
    expect(git(plan.path, 'rev-parse', 'HEAD')).toBe(beforeHead)
    expect(git(plan.path, 'write-tree')).toBe(beforeIndex)
    expect(git(plan.path, 'status', '--porcelain=v1')).toBe(beforeStatus)
    expect(git(plan.path, 'stash', 'list')).toBe('')
    writeFileSync(join(plan.path, 'code.txt'), 'later\n')
    expect(await captureSessionCheckpoint(context(), user.id)).toEqual(checkpoint)
    const list = await listSessionCheckpoints(context()); expect(list.supported).toBe(true); expect(list.checkpoints).toHaveLength(1)
  })

  it('restores files, staging and HEAD, while saving a recoverable pre-restore conversation and untracked files', async () => {
    writeFileSync(join(plan.path, 'code.txt'), 'staged\n'); git(plan.path, 'add', 'code.txt')
    writeFileSync(join(plan.path, 'code.txt'), 'before turn\n'); writeFileSync(join(plan.path, 'before.txt'), 'present before\n')
    const checkpoint = await captureSessionCheckpoint(context(), user.id)
    const originalHead = git(plan.path, 'rev-parse', 'HEAD')
    writeFileSync(recordFile(), jsonl([user, { id: 'answer', type: 'assistant', content: 'Done' }]))
    writeFileSync(join(plan.path, 'code.txt'), 'after turn\n'); rmSync(join(plan.path, 'before.txt'))
    writeFileSync(join(plan.path, 'after.txt'), 'new after\n')
    git(plan.path, 'add', '.'); git(plan.path, 'commit', '-m', 'Agent commit')
    writeFileSync(join(plan.path, 'local.txt'), 'untracked after\n')
    writeFileSync(join(plan.path, '.env'), 'ignored secret stays\n')
    const afterHead = git(plan.path, 'rev-parse', 'HEAD'), afterConversation = readFileSync(recordFile(), 'utf8')
    const result = await restore(checkpoint.id)
    expect(git(plan.path, 'rev-parse', 'HEAD')).toBe(originalHead)
    expect(readFileSync(join(plan.path, 'code.txt'), 'utf8')).toBe('before turn\n')
    expect(git(plan.path, 'show', ':code.txt')).toBe('staged')
    expect(readFileSync(join(plan.path, 'before.txt'), 'utf8')).toBe('present before\n')
    expect(existsSync(join(plan.path, 'after.txt'))).toBe(false); expect(existsSync(join(plan.path, 'local.txt'))).toBe(false)
    expect(readFileSync(join(plan.path, '.env'), 'utf8')).toBe('ignored secret stays\n')
    expect(readFileSync(recordFile(), 'utf8')).toBe(jsonl([]))
    const recoveryPath = join(sessionDir, 'checkpoints', result.recovery.id, 'session.jsonl')
    expect(readFileSync(recoveryPath, 'utf8')).toBe(afterConversation)
    const recovered = await restoreSessionCheckpoint({ ...context(), checkpointId: result.recovery.id, assertIdle: idle,
      restoreConversation: async target => { writeFileSync(recordFile(), readFileSync(checkpointConversationPath(sessionDir, target))) }, rollbackConversation: idle })
    expect(recovered.restored.kind).toBe('recovery')
    expect(git(plan.path, 'rev-parse', 'HEAD')).toBe(afterHead)
    expect(readFileSync(join(plan.path, 'code.txt'), 'utf8')).toBe('after turn\n')
    expect(readFileSync(join(plan.path, 'local.txt'), 'utf8')).toBe('untracked after\n')
    expect(readFileSync(recordFile(), 'utf8')).toBe(afterConversation)
  })

  it('refuses an ignored collision, preserves ignored contents, and makes no destructive change', async () => {
    writeFileSync(join(plan.path, 'protected.txt'), 'old tracked\n'); git(plan.path, 'add', 'protected.txt'); git(plan.path, 'commit', '-m', 'Tracked file')
    const checkpoint = await captureSessionCheckpoint(context(), user.id)
    writeFileSync(recordFile(), jsonl([user])); git(plan.path, 'rm', 'protected.txt')
    writeFileSync(join(plan.path, '.gitignore'), '.env\nprotected.txt\n'); git(plan.path, 'add', '.gitignore'); git(plan.path, 'commit', '-m', 'Ignore file')
    writeFileSync(join(plan.path, 'protected.txt'), 'new secret\n')
    const head = git(plan.path, 'rev-parse', 'HEAD')
    await expect(restore(checkpoint.id)).rejects.toThrow('ignored file')
    expect(readFileSync(join(plan.path, 'protected.txt'), 'utf8')).toBe('new secret\n'); expect(git(plan.path, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('rolls back files and conversation if durable conversation restoration fails', async () => {
    const checkpoint = await captureSessionCheckpoint(context(), user.id)
    writeFileSync(recordFile(), jsonl([user])); writeFileSync(join(plan.path, 'code.txt'), 'keep current\n'); writeFileSync(join(plan.path, 'later.txt'), 'keep later\n')
    const conversation = readFileSync(recordFile(), 'utf8')
    await expect(restore(checkpoint.id, async () => { writeFileSync(recordFile(), 'partially saved'); throw new Error('Disk failure') })).rejects.toThrow('Disk failure')
    expect(readFileSync(join(plan.path, 'code.txt'), 'utf8')).toBe('keep current\n'); expect(readFileSync(join(plan.path, 'later.txt'), 'utf8')).toBe('keep later\n')
    expect(readFileSync(recordFile(), 'utf8')).toBe(conversation)
    expect((await listSessionCheckpoints(context())).checkpoints.some(checkpoint => checkpoint.kind === 'recovery')).toBe(true)
  })

  it('rejects active writers before materialization and validates the durable owner marker', async () => {
    const checkpoint = await captureSessionCheckpoint(context(), user.id); writeFileSync(recordFile(), jsonl([user]))
    await expect(restoreSessionCheckpoint({ ...context(), checkpointId: checkpoint.id, assertIdle: () => { throw new Error('Another child session is writing') }, restoreConversation: async () => {}, rollbackConversation: idle })).rejects.toThrow('Another child')
    await expect(captureSessionCheckpoint({ ...context(), plan: { ...plan, token: 'other-owner' } }, 'turn-two')).rejects.toBeInstanceOf(SessionCheckpointError)
    expect(readFileSync(join(plan.path, 'code.txt'), 'utf8')).toBe('base\n')
  })

  it('does not offer a damaged checkpoint and refuses snapshots over the file size limit', async () => {
    const checkpoint = await captureSessionCheckpoint(context(), user.id)
    const record = JSON.parse(readFileSync(join(sessionDir, 'checkpoints', checkpoint.id, 'record.json'), 'utf8'))
    writeFileSync(join(sessionDir, 'checkpoints', checkpoint.id, 'record.json'), JSON.stringify({ ...record, snapshotRef: 'refs/heads/main' }))
    expect((await listSessionCheckpoints(context())).checkpoints).toHaveLength(0)
    writeFileSync(join(plan.path, 'large.bin'), Buffer.alloc(20 * 1024 * 1024 + 1))
    await expect(captureSessionCheckpoint(context(), 'large-turn')).rejects.toThrow('checkpoint limits')
  })
})
