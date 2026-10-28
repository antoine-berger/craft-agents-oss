import type { PrQuickOperationRequest, PrQuickOperationResult } from '@craft-agent/shared/protocol'
import { GitHubAuthError, GitHubRefusedError } from './github-client'
import type { GqlPullRequestSummary, GqlDetailsResponse } from './github-queries'
import { DETAILS_QUERY } from './github-queries'
import { mapDetails, mapSummary, pickMergeMethod } from './map-github'
import type { LocalStatus } from './local-git'
import type { RepoCoordinates } from './remote-url'

const READY = `mutation ReadyPr($prId: ID!) {
  markPullRequestReadyForReview(input: {pullRequestId: $prId}) { pullRequest { id } }
}`
const MERGE = `mutation MergePr($prId: ID!, $head: GitObjectID!, $method: PullRequestMergeMethod!) {
  mergePullRequest(input: {pullRequestId: $prId, expectedHeadOid: $head, mergeMethod: $method}) { pullRequest { merged } }
}`
const ENQUEUE = `mutation QueuePr($prId: ID!, $head: GitObjectID!) {
  enqueuePullRequest(input: {pullRequestId: $prId, expectedHeadOid: $head}) { mergeQueueEntry { id } }
}`

export interface QuickActionDeps {
  localStatus(): Promise<LocalStatus>
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>
  rerunFailedJobs(runId: string): Promise<void>
}

/** Fresh server state and an exact clicked commit gate every GitHub write. */
export async function runPrQuickOperation(node: GqlPullRequestSummary, request: PrQuickOperationRequest, deps: QuickActionDeps): Promise<PrQuickOperationResult> {
  if (!request || !['merge', 'ready', 'rerun'].includes(request.operation)) throw new Error('Unknown PR action.')
  if (!request.expectedHeadOid || node.headRefOid !== request.expectedHeadOid) throw new Error('The PR changed. Refresh it before trying again.')
  if (node.state !== 'OPEN') throw new Error('This PR is no longer open.')
  if (request.operation === 'ready') {
    if (node.isDraft) {
      const result = await deps.graphql<{ markPullRequestReadyForReview?: { pullRequest?: { id: string } } }>(READY, { prId: node.id })
      if (!result.markPullRequestReadyForReview?.pullRequest) throw new Error('GitHub did not mark the PR ready for review.')
    }
    return { ok: true, outcome: 'ready' }
  }
  if (request.operation === 'rerun') return rerunChecks(node, deps)
  return mergePr(node, request, deps)
}

async function mergePr(node: GqlPullRequestSummary, request: PrQuickOperationRequest, deps: QuickActionDeps): Promise<PrQuickOperationResult> {
  const local = await deps.localStatus()
  const summary = mapSummary(node, local, { fetchedAt: Date.now(), via: '' })
  if (local.headMatchesLocal !== true || local.localDirty || local.localAhead) throw new Error('Commit and push this worktree before merging. Its HEAD must match the PR.')
  if (!summary.quickActions?.canMerge) throw new Error('Your GitHub account cannot merge this PR.')
  if (node.mergeQueueEntry) return { ok: true, outcome: 'queued' }
  const ready = !node.isDraft && !summary.attentionFeedback?.length && summary.unresolvedThreads === 0 && !summary.attentionStale
    && (summary.reviewDecision === 'approved' || summary.reviewDecision === 'none')
    && (summary.checks === 'success' || summary.checks === 'none')
    && (summary.mergeState === 'clean' || (node.isMergeQueueEnabled && summary.mergeState === 'blocked'))
  if (!ready) throw new Error('This PR still has merge blockers. Refresh its checks and review.')
  const variables = { prId: node.id, head: request.expectedHeadOid }
  if (node.isMergeQueueEnabled) {
    const result = await deps.graphql<{ enqueuePullRequest?: { mergeQueueEntry?: { id: string } } }>(ENQUEUE, variables)
    if (!result.enqueuePullRequest?.mergeQueueEntry) throw new Error('GitHub did not enqueue the PR.')
    return { ok: true, outcome: 'queued' }
  }
  const method = pickMergeMethod(node.baseRepository, request.method)
  if (!method) throw new Error('The repository does not allow this merge method.')
  const result = await deps.graphql<{ mergePullRequest?: { pullRequest?: { merged: boolean } } }>(MERGE, { ...variables, method: method.toUpperCase() })
  if (!result.mergePullRequest?.pullRequest?.merged) throw new Error('GitHub did not merge the PR.')
  return { ok: true, outcome: 'merged' }
}

async function rerunChecks(node: GqlPullRequestSummary, deps: QuickActionDeps): Promise<PrQuickOperationResult> {
  const url = new URL(node.url)
  const [, owner, name] = url.pathname.split('/')
  const result = await deps.graphql<GqlDetailsResponse>(DETAILS_QUERY, { owner, name, number: node.number })
  const details = result.repository?.pullRequest
  if (!details) throw new Error('Could not load the failing checks.')
  const mapped = mapDetails(details)
  if (mapped?.lastCommit.sha !== node.headRefOid) throw new Error('The PR changed. Refresh it before restarting checks.')
  const runs = failedWorkflowRunIds(mapped.checks, node.url)
  if (!runs.length) throw new Error('No failed GitHub Actions run can be restarted for this PR.')
  for (const runId of runs) await deps.rerunFailedJobs(runId)
  return { ok: true, outcome: 'rerun' }
}

/** Ignore external checks and links belonging to another repository. */
export function failedWorkflowRunIds(checks: Array<{ status: string; url?: string }>, prUrl: string): string[] {
  const pr = new URL(prUrl)
  const repoPath = pr.pathname.split('/').slice(0, 3).join('/').toLowerCase()
  const runs = new Set<string>()
  for (const check of checks) {
    if (check.status !== 'failure' || !check.url) continue
    try {
      const url = new URL(check.url)
      if (url.origin !== pr.origin || !url.pathname.toLowerCase().startsWith(`${repoPath}/actions/runs/`)) continue
      const match = url.pathname.slice(repoPath.length).match(/^\/actions\/runs\/(\d+)(?:\/job\/\d+)?\/?$/)
      if (match) runs.add(match[1]!)
    } catch { /* A malformed provider link is not a GitHub Actions run. */ }
  }
  return [...runs]
}

/** Tokens stay on the workspace server; only known numeric workflow run IDs reach this endpoint. */
export async function rerunFailedJobs(coords: RepoCoordinates, token: string, runId: string): Promise<void> {
  if (!/^\d+$/.test(runId)) throw new Error('Invalid workflow run ID.')
  const base = coords.host === 'github.com' ? 'https://api.github.com' : `https://${coords.host}/api/v3`
  const response = await fetch(`${base}/repos/${encodeURIComponent(coords.owner)}/${encodeURIComponent(coords.repo)}/actions/runs/${runId}/rerun-failed-jobs`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'craft-agents-pr-watch' },
  })
  if (response.status === 401 || response.status === 403 || response.status === 404) throw new GitHubAuthError('GitHub denied access to restart this workflow.', response.status)
  if (!response.ok) throw new GitHubRefusedError(`GitHub refused to restart workflow ${runId} (${response.status}).`)
}
