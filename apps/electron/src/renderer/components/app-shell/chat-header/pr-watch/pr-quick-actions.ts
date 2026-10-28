import type { PrEntry, PrSummary, PrWatchState } from '@craft-agent/shared/protocol'
import { hasReviewFeedback, pinnedCheckoutPreface, prCardActionMessage } from './pr-watch-state'

export type PrQuickAction = 'create' | 'commit-push' | 'push' | 'pull' | 'rebase' | 'resolve' | 'fix' | 'fix-ci' | 'ready' | 'rerun' | 'auto-merge' | 'disable-auto-merge' | 'merge' | 'queued' | 'archive'

/** Match Conductor's next-action priority; merging is available only with the native server support. */
export function nextPrQuickAction(state: PrWatchState, origin?: PrEntry['origin']): PrQuickAction | null {
  if (state.kind === 'none') return 'create'
  if (state.kind !== 'pr') return null
  const pr = state.summary
  if (pr.state === 'merged') return origin === 'bound' ? null : 'archive'
  if (pr.state === 'closed') return null
  if (pr.quickActions?.queued) return 'queued'
  if (origin !== 'bound') {
    if (pr.localDirty) return 'commit-push'
    if (pr.localAhead > 0) return 'push'
    if (pr.headMatchesLocal === false) return 'pull'
  }
  if (pr.mergeState === 'conflicting') return 'resolve'
  if (hasReviewFeedback(pr) || pr.attentionFeedback?.length) return 'fix'
  if (pr.state === 'draft') return pr.quickActions ? 'ready' : null
  if (pr.mergeState === 'behind') return 'rebase'
  if (pr.checks === 'failure') return 'fix-ci'
  if (pr.autoMerge?.enabled) return 'disable-auto-merge'
  if (pr.checks === 'pending' || pr.reviewDecision === 'review_required') {
    return !pr.autoMergeBlocked && pr.quickActions?.canMerge ? 'auto-merge' : null
  }
  const ready = !pr.attentionStale && pr.headMatchesLocal === true && origin !== 'bound'
    && pr.quickActions?.canMerge && (pr.reviewDecision === 'approved' || pr.reviewDecision === 'none')
    && (pr.mergeState === 'clean' || (pr.quickActions.mergeQueue && pr.mergeState === 'blocked'))
  return ready ? 'merge' : null
}

export function prQuickActionMessage(action: PrQuickAction, state: PrWatchState, origin?: PrEntry['origin']): string | null {
  if (action === 'create') return 'Create a pull request for the changes in this session’s worktree. Review the diff, run the relevant checks, commit and push the changes, and write a clear PR title and description. Use the intended base branch (including the parent PR branch when this is a stack). If there are no changes, tell me instead of creating an empty PR.'
  if (state.kind !== 'pr') return null
  const { summary: pr, details } = state
  if (action === 'resolve' || action === 'fix' || action === 'fix-ci') return prCardActionMessage(action, pr, details, origin)
  const target = origin === 'bound' ? 'that separate checkout' : 'this session’s worktree'
  const scope = `${origin === 'bound' ? pinnedCheckoutPreface(pr) + '\n\n' : ''}Work on PR #${pr.number} (${pr.url}), branch ${JSON.stringify(pr.headRef)}, in ${target}.`
  if (action === 'commit-push') return `${scope} Review the local changes, run the relevant checks, commit them and push to the PR branch. Do not merge the PR.`
  if (action === 'push') return `${scope} Push the local commits to the PR branch. Use a normal push; if it needs a force push, explain why and ask first. Do not merge the PR.`
  if (action === 'pull') return `${scope} Fetch the PR branch and bring this worktree up to date with it using a fast-forward. Preserve all local changes. If branches diverged, explain the divergence and ask before rewriting commits.`
  if (action === 'rebase') return `${scope} Fetch the PR’s current base branch ${JSON.stringify(pr.baseRef)} and rebase this branch onto that base, preserving the parent branch if this PR is stacked. Resolve conflicts while preserving both sides’ intent, run the relevant checks, then push with --force-with-lease pinned to the remote head fetched before the rebase. Never force push without a lease and never merge the PR. If the remote head changed, stop and explain.`
  return null
}

export function canRerunPrChecks(pr: PrSummary): boolean {
  return (pr.state === 'open' || pr.state === 'draft') && !!pr.quickActions && pr.checks === 'failure'
}
