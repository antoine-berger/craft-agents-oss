import type { PrEntry, PrSummary, PrWatchState } from '@craft-agent/shared/protocol'
import { rebaseAndPushInstruction } from '@craft-agent/shared/pr-watch'
import { hasReviewFeedback } from './pr-watch-state'

export type PrQuickAction = 'create' | 'commit-push' | 'push' | 'pull' | 'rebase' | 'resolve' | 'fix' | 'fix-ci' | 'ready' | 'rerun' | 'auto-merge' | 'disable-auto-merge' | 'merge' | 'queued' | 'archive'

/** Match Conductor's next-action priority; merging is available only with the native server support. */
export function nextPrQuickAction(state: PrWatchState, origin?: PrEntry['origin']): PrQuickAction | null {
  if (state.kind === 'none') return 'create'
  if (state.kind !== 'pr') return null
  const pr = state.summary
  if (pr.attentionStale) return null
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
  if (action === 'create') return 'Create a PR for this worktree. Review the changes, run the relevant checks, commit and push. Use the parent branch as the base for a stack. If there are no changes, do not create an empty PR.'
  if (state.kind !== 'pr') return null
  const { summary: pr, details } = state
  let message: string
  switch (action) {
    case 'commit-push': message = 'Commit and push all changes. Review the diff and run the relevant checks first. Do not merge.'; break
    case 'push': message = 'Push the local commits. Use a normal push; ask before any force push. Do not merge.'; break
    case 'pull': message = 'Fetch the PR branch and fast-forward this worktree to it. Preserve local changes; if branches diverge, ask before rewriting commits.'; break
    case 'rebase':
    case 'resolve': message = rebaseAndPushInstruction(pr); break
    case 'fix': message = "Address the open review comments. Read reviews and unresolved inline threads, fix applicable issues, run the relevant checks and summarize changes; explain any disagreement. Don't push, reply on GitHub or resolve threads unless I ask."; break
    case 'fix-ci': message = "Fix the failing CI actions. Read the failure logs, reproduce and fix actual failures, then rerun the relevant checks. If flaky or unrelated, explain instead of changing code. Don't push unless I ask."; break
    default: return null
  }
  const context = `PR #${pr.number} (${pr.url}), branch ${JSON.stringify(pr.headRef)}.`
  const checkout = origin === 'bound'
    ? "This PR is pinned to this session. Reuse its existing worktree or create a separate checkout of the PR's repository. Don't switch this folder's branch or change its files. Work there and report its path."
    : ''
  const checks = action === 'fix-ci' ? details?.checks.filter(check => check.status === 'failure')
    .map(check => `- ${check.name}${check.url ? ` (${check.url})` : ''}`).join('\n') : ''
  return [message, context, checkout, checks].filter(Boolean).join('\n\n')
}

export function canRerunPrChecks(pr: PrSummary): boolean {
  return (pr.state === 'open' || pr.state === 'draft') && !!pr.quickActions && pr.checks === 'failure'
}
