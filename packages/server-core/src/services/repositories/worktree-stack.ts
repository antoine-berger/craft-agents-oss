import type { OwnedWorktree, SessionWorktreeMetadata } from '@craft-agent/shared/sessions'
import { existsSync } from 'node:fs'
import type { WorktreeStackSession, WorktreeStackSnapshot } from '../../../../shared/src/protocol/worktree-stack'
import { runGit } from '../git'
import { commonGitDir } from './discover'

export interface StackSession {
  id: string
  workspaceId: string
  name?: string
  isArchived?: boolean
  hidden?: boolean
  parentSessionId?: string
  workingDirectory?: string
  worktree?: SessionWorktreeMetadata
}

type StackParent = NonNullable<SessionWorktreeMetadata['stackParent']>

function branchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref.replace(/^(?:refs\/remotes\/)?origin\//, '')
}

function directory(session: StackSession): string | undefined {
  return session.workingDirectory ?? session.worktree?.owned?.path
}

function summary(session: StackSession, branch?: string): WorktreeStackSession {
  return { sessionId: session.id, title: session.name || 'Untitled session', branch, archived: !!session.isArchived }
}

function hasCycle(sessionId: string, parentId: string | undefined, sessions: readonly StackSession[]): boolean {
  const byId = new Map(sessions.map(session => [session.id, session]))
  const visited = new Set([sessionId])
  while (parentId) {
    if (visited.has(parentId)) return true
    visited.add(parentId)
    parentId = byId.get(parentId)?.worktree?.stackParent?.parentSessionId
  }
  return false
}

/** Associate only an explicitly copied branch, after Git allocated its exact starting commit. */
export async function captureStackParent(input: {
  sessionId: string
  workspaceId: string
  requestedBranch: string
  plan: OwnedWorktree
  sessions: readonly StackSession[]
}): Promise<StackParent> {
  const branch = branchName(input.requestedBranch)
  const parent: StackParent = {
    branch, ref: input.plan.base, baseCommit: input.plan.baseCommit,
    repositoryGitDir: input.plan.gitDir, association: 'unmapped',
  }
  const candidates: StackSession[] = []
  const identities = new Map<string, Promise<{ gitDir: string | null; branch: string | null }>>()
  const possible = input.sessions.filter(session => session.id !== input.sessionId && session.workspaceId === input.workspaceId && !session.hidden && !session.parentSessionId)
  // Resolve legacy/imported checkouts too, with bounded local process concurrency.
  for (let offset = 0; offset < possible.length; offset += 8) {
    await Promise.all(possible.slice(offset, offset + 8).map(async session => {
      const plan = session.worktree?.owned
      if (plan && plan.gitDir !== input.plan.gitDir) return
      const path = directory(session)
      if (!path || !existsSync(path)) return
      let identity = identities.get(path)
      if (!identity) {
        identity = Promise.all([commonGitDir(path), runGit(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])])
          .then(([gitDir, branch]) => ({ gitDir, branch }))
        identities.set(path, identity)
      }
      const actual = await identity
      if (actual.gitDir === input.plan.gitDir && actual.branch === branch) candidates.push(session)
    }))
  }
  if (candidates.length > 1) parent.association = 'ambiguous'
  else if (candidates.length === 1) {
    const candidate = candidates[0]!
    if (hasCycle(input.sessionId, candidate.id, possible)) throw new Error('The selected branch would create a session stack cycle.')
    parent.parentSessionId = candidate.id
    parent.association = 'verified'
  }
  return parent
}

/** Local branch ancestry is evidence; this never fetches, rebases, pushes or changes a PR. */
export async function getWorktreeStack(input: {
  session: StackSession
  sessions: readonly StackSession[]
  parentMerged?: boolean
  now?: number
}): Promise<WorktreeStackSnapshot> {
  const { session } = input
  const observedAt = input.now ?? Date.now()
  const visible = input.sessions.filter(item => item.workspaceId === session.workspaceId)
  const children = visible.filter(item => !item.hidden && item.worktree?.stackParent?.parentSessionId === session.id)
    .map(item => summary(item, item.worktree?.owned?.checkout?.branch ?? item.worktree?.owned?.branch))
  const result: WorktreeStackSnapshot = { sessionId: session.id, status: 'none', children, observedAt }
  const parent = session.worktree?.stackParent
  const path = directory(session)
  if (!path) return { ...result, status: 'unavailable', reason: 'This session has no available worktree.' }
  const gitDir = await commonGitDir(path)
  if (!gitDir) return { ...result, status: 'unavailable', reason: 'The session worktree is unavailable.' }
  result.branch = await runGit(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']) ?? 'Detached HEAD'
  if (!parent) return result
  result.status = 'ready'
  result.parent = {
    branch: parent.branch, baseCommit: parent.baseCommit, state: 'unknown',
    detail: 'Local branch evidence is unavailable.', ...(input.parentMerged ? { merged: true } : {}),
  }
  const view = result.parent
  if (parent.repositoryGitDir !== gitDir || !/^[a-f\d]{40,64}$/.test(parent.baseCommit)) {
    view.detail = 'The recorded parent belongs to another repository or has invalid base metadata.'
    return result
  }
  if (hasCycle(session.id, parent.parentSessionId, visible)) {
    view.state = 'cycle'; view.detail = 'The saved session relationships contain a cycle. Choose a different base before continuing.'
    return result
  }
  if (parent.association === 'ambiguous') {
    view.state = 'ambiguous'; view.detail = 'Several sessions use the starting branch; no parent session was guessed.'
    return result
  }
  let parentRef = parent.ref
  if (parent.parentSessionId) {
    const linked = visible.find(item => item.id === parent.parentSessionId)
    if (!linked) { view.state = 'missing-parent'; view.detail = 'The parent session is no longer available.'; return result }
    view.session = summary(linked, parent.branch)
    const parentPath = directory(linked)
    if (!parentPath || await commonGitDir(parentPath) !== gitDir) {
      view.state = 'missing-parent'; view.detail = 'The parent session no longer has this repository checkout.'; return result
    }
    const actualBranch = await runGit(parentPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    if (actualBranch !== parent.branch) {
      view.state = 'parent-switched'; view.detail = 'The parent session switched branches. Its original stack base is retained.'; return result
    }
    parentRef = `refs/heads/${parent.branch}`
  }
  if (!parentRef.startsWith('refs/heads/') && !parentRef.startsWith('refs/remotes/')) {
    view.detail = 'The saved parent is not an exact local branch reference.'; return result
  }
  const current = await runGit(path, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${parentRef}^{commit}`])
  if (!current) { view.state = 'missing-parent'; view.detail = input.parentMerged ? 'The parent PR is merged and its local branch is unavailable. Verify the child PR base before continuing.' : 'The recorded parent branch is unavailable locally. No fetch was performed.'; return result }
  view.currentCommit = current
  const childHead = await runGit(path, ['rev-parse', '--verify', 'HEAD^{commit}'])
  if (!childHead) return result
  const inclusion = await runGit(path, ['rev-list', '--left-right', '--count', `${current}...${childHead}`, '--'])
  if (!inclusion || !/^\d+\s+\d+$/.test(inclusion)) return result
  const movement = await runGit(path, ['rev-list', '--left-right', '--count', `${parent.baseCommit}...${current}`, '--'])
  if (!movement || !/^\d+\s+\d+$/.test(movement)) return result
  const parentAdvanced = Number(movement.split(/\s+/)[0]) === 0
  if (Number(inclusion.split(/\s+/)[0]) === 0) {
    const original = parentAdvanced ? null : await runGit(path, ['rev-list', '--left-right', '--count', `${parent.baseCommit}...${childHead}`, '--'])
    if (!parentAdvanced && (!original || !/^\d+\s+\d+$/.test(original))) return result
    if (!parentAdvanced && Number(original!.split(/\s+/)[0]) === 0) {
      view.state = 'diverged'; view.detail = 'This child still contains commits removed from the parent history. Review its base before continuing.'
    } else {
      view.state = 'up-to-date'; view.detail = 'This checkout contains the current local parent branch.'
    }
    return result
  }
  if (parentAdvanced) {
    view.state = 'needs-restack'; view.detail = 'The parent branch advanced. Review and restack this child when you choose.'
  } else {
    view.state = 'diverged'; view.detail = 'The parent branch history changed. Review the stack base before rebasing.'
  }
  return result
}
