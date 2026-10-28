import type { PrWatchSessionState } from '@craft-agent/shared/protocol'

/** Conductor 0.92's derived status: the checkout's PR, independent of agent activity. */
export function deriveSessionStatus(state: PrWatchSessionState): string | undefined {
  if (state.kind === 'none') return 'todo'
  if (state.kind !== 'ready') return undefined
  const branch = state.prs.find(pr => pr.origin === 'branch')
  if (!branch) return state.incomplete ? undefined : 'todo'
  if (branch.summary.attentionStale) return undefined
  switch (branch.summary.state) {
    case 'open':
    case 'draft': return 'needs-review'
    case 'merged': return 'done'
    case 'closed': return 'cancelled'
  }
}
