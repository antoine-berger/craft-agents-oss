import { expect, it } from 'bun:test'
import type { GqlPullRequestSummary } from './github-queries'
import { failedWorkflowRunIds, runPrQuickOperation, type QuickActionDeps } from './quick-actions'
const node: GqlPullRequestSummary = {
  id: 'PR_7', number: 7, title: 'Feature', url: 'https://github.com/acme/app/pull/7', state: 'OPEN', isDraft: false,
  headRefName: 'feature', baseRefName: 'main', headRefOid: 'abc', headRepositoryOwner: { login: 'acme' }, reviewDecision: 'APPROVED',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', autoMergeRequest: null, viewerCanEnableAutoMerge: false,
  baseRepository: { viewerPermission: 'WRITE', autoMergeAllowed: true, viewerDefaultMergeMethod: 'SQUASH', mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, reviewThreads: { nodes: [] },
}
function setup() {
  const writes: Array<{ query: string; variables: Record<string, unknown> }> = []
  const deps: QuickActionDeps = {
    localStatus: async () => ({ headMatchesLocal: true, localDirty: false, localAhead: 0 }),
    graphql: async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
      writes.push({ query, variables })
      return { mergePullRequest: { pullRequest: { merged: true } }, enqueuePullRequest: { mergeQueueEntry: { id: 'MQ7' } }, markPullRequestReadyForReview: { pullRequest: { id: 'PR_7' } } } as T
    }, rerunFailedJobs: async () => { throw new Error('Unexpected rerun') },
  }
  return { deps, writes }
}
const request = { operation: 'merge' as const, expectedHeadOid: 'abc' }
it('merges the exact clicked HEAD with the repository method; queues when required', async () => {
  const { deps, writes } = setup()
  expect(await runPrQuickOperation(node, request, deps)).toEqual({ ok: true, outcome: 'merged' })
  expect(writes[0]!.query).toContain('expectedHeadOid: $head')
  expect(writes[0]!.variables).toEqual({ prId: 'PR_7', head: 'abc', method: 'SQUASH' })
  expect(await runPrQuickOperation({ ...node, isMergeQueueEnabled: true, mergeStateStatus: 'BLOCKED' }, request, deps)).toEqual({ ok: true, outcome: 'queued' })
  expect(writes[1]!.query).toContain('enqueuePullRequest')
  expect(writes[1]!.variables).toEqual({ prId: 'PR_7', head: 'abc' })
})
it('refuses stale commits, incomplete review, pending CI and insufficient rights without writes', async () => {
  for (const override of [
    { headRefOid: 'new' }, { state: 'CLOSED' }, { isDraft: true }, { reviewDecision: 'REVIEW_REQUIRED' },
    { reviewDecision: 'CHANGES_REQUESTED' }, { mergeStateStatus: 'BEHIND' }, { mergeStateStatus: 'DIRTY' },
    { reviewThreads: { nodes: [{ isResolved: false }] } }, { reviewThreads: { nodes: [], pageInfo: { hasNextPage: true } } },
    { commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } },
    { baseRepository: { ...node.baseRepository!, viewerPermission: 'READ' } },
  ] as Partial<GqlPullRequestSummary>[]) {
    const { deps, writes } = setup()
    await expect(runPrQuickOperation({ ...node, ...override }, request, deps)).rejects.toThrow()
    expect(writes).toHaveLength(0)
  }
})
it('refuses local changes, missing pushed commits, disallowed merge methods and GitHub refusal', async () => {
  for (const local of [{ headMatchesLocal: false, localDirty: false, localAhead: 0 }, { headMatchesLocal: true, localDirty: true, localAhead: 0 }, { headMatchesLocal: true, localDirty: false, localAhead: 2 }]) {
    const { deps, writes } = setup(); deps.localStatus = async () => local
    await expect(runPrQuickOperation(node, request, deps)).rejects.toThrow('worktree')
    expect(writes).toHaveLength(0)
  }
  const { deps, writes } = setup()
  await expect(runPrQuickOperation(node, { ...request, method: 'rebase' }, deps)).rejects.toThrow('method')
  expect(writes).toHaveLength(0)
  deps.graphql = async <T>() => ({} as T)
  await expect(runPrQuickOperation(node, request, deps)).rejects.toThrow('did not merge')
})
it('marks drafts ready directly and only extracts failed Actions runs belonging to this repository', async () => {
  const { deps, writes } = setup()
  expect(await runPrQuickOperation({ ...node, isDraft: true }, { ...request, operation: 'ready' }, deps)).toEqual({ ok: true, outcome: 'ready' })
  expect(writes[0]!.query).toContain('markPullRequestReadyForReview')
  const check = (url: string, status = 'failure') => ({ url, status })
  expect(failedWorkflowRunIds([
    check('https://github.com/acme/app/actions/runs/12/job/1'), check('https://github.com/acme/app/actions/runs/12/job/2'),
    check('https://github.com/acme/app/actions/runs/13/job/3', 'success'), check('https://evil.example/acme/app/actions/runs/14'),
    check('https://github.com/other/app/actions/runs/15'), check('not a url'),
  ], node.url)).toEqual(['12'])
})
it('restarts only failed jobs from the current PR commit, and rejects a concurrent new commit', async () => {
  const restarted: string[] = []
  const { deps } = setup()
  let sha = 'abc'
  deps.rerunFailedJobs = async id => { restarted.push(id) }
  deps.graphql = async <T>() => ({ repository: { pullRequest: {
    additions: 1, deletions: 0, changedFiles: 1,
    commits: { nodes: [{ commit: { oid: sha, messageHeadline: 'Feature', committedDate: '2026-10-27T00:00:00Z', author: { name: 'A', user: null },
      statusCheckRollup: { contexts: { nodes: [
        { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/app/actions/runs/12/job/1' },
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/app/actions/runs/13/job/2' },
      ] } },
    } }] }, latestOpinionatedReviews: { nodes: [] }, reviewRequests: { nodes: [] },
  } } } as T)
  expect(await runPrQuickOperation(node, { ...request, operation: 'rerun' }, deps)).toEqual({ ok: true, outcome: 'rerun' })
  expect(restarted).toEqual(['12'])
  sha = 'changed'
  await expect(runPrQuickOperation(node, { ...request, operation: 'rerun' }, deps)).rejects.toThrow('changed')
  expect(restarted).toEqual(['12'])
})
