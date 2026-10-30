import type { PrWatchSessionState } from '@craft-agent/shared/protocol'
import type { AttentionReason } from '../../../../shared/src/protocol/session-attention'

/** No natural-language question heuristic: only current GitHub review/check evidence. */
export function githubAttention(state: PrWatchSessionState, now: number, activeAutoFixPrId?: string): AttentionReason[] | null {
  if (state.kind === 'loading' || state.kind === 'unavailable') return null
  if (state.kind === 'none') return []
  if (state.incomplete) return null
  const reasons: AttentionReason[] = []
  for (const entry of state.prs) {
    const p = entry.summary
    if (p.attentionStale || (entry.origin === 'branch' && p.headMatchesLocal === null)) return null
    if (now > (p.freshUntil ?? p.fetchedAt + 10 * 60_000)) return null
    if (p.state !== 'open' && p.state !== 'draft') continue
    // A local commit newer/different from the remote head needs a push, not old review/CI feedback.
    if (p.headMatchesLocal === false || (entry.origin === 'branch' && p.localAhead > 0)) continue
    // Auto-fix actively doing the work should not summon a person for that same feedback.
    if (activeAutoFixPrId === entry.id && entry.autoFix) continue
    const add = (suffix: string, kind: 'review' | 'ci', title: string, detail?: string, url = p.url) => reasons.push({
      id: `github:${entry.id}:${suffix}`, source: 'github', kind, title, detail,
      createdAt: 0, action: { type: 'external', url },
    })
    if (p.checks === 'failure') add('ci', 'ci', `PR #${p.number} · CI failed`, 'Checks failed on the current PR commit', `${p.url}/checks`)
    for (const feedback of p.attentionFeedback ?? []) add(feedback.id, 'review', `PR #${p.number} · ${feedback.author}`, feedback.title, feedback.url)
    // Compatibility with old summaries: aggregate reviewDecision alone cannot prove commit freshness.
    if (!p.attentionFeedback && p.unresolvedThreads > 0) add('threads', 'review', `PR #${p.number} · ${p.unresolvedThreads} unresolved review threads`)
  }
  return reasons
}

/** Reconcile each PR separately: a failed bound PR cannot erase its old request or hide new CI failures elsewhere. */
export function reconcileGithubAttention(state: PrWatchSessionState, previous: AttentionReason[], now: number, activeAutoFixPrId?: string): { reasons: AttentionReason[]; stale: boolean } {
  const old = previous.filter(r => r.source === 'github')
  if (state.kind === 'loading' || state.kind === 'unavailable') return { reasons: old, stale: true }
  if (state.kind === 'none') return { reasons: [], stale: false }
  const result: AttentionReason[] = []
  let stale = !!state.incomplete
  for (const entry of state.prs) {
    const next = githubAttention({ kind: 'ready', prs: [entry] }, now, activeAutoFixPrId)
    if (next === null) {
      stale = true
      result.push(...old.filter(reason => reason.id.startsWith(`github:${entry.id}:`)))
    } else result.push(...next.map(reason => ({ ...reason, createdAt: old.find(r => r.id === reason.id)?.createdAt ?? now })))
  }
  if (state.incomplete) result.push(...old.filter(reason => !state.prs.some(entry => reason.id.startsWith(`github:${entry.id}:`))))
  return { reasons: result, stale }
}
