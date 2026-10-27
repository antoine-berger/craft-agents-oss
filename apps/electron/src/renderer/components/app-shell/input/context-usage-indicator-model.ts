import type { ContextUsageSnapshot } from '@craft-agent/core/types'

const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

/** Only the latest backend occupancy snapshot participates; billing totals never do. */
export function contextIndicatorValues(snapshot?: ContextUsageSnapshot, modelContextWindow?: number | null, reportedContextWindow?: number | null) {
  const used = count(snapshot?.usedTokens)
  const limit = count(snapshot?.limitTokens)
  const modelWindow = count(modelContextWindow)
  const reportedWindow = count(reportedContextWindow)
  // First-turn SDK usage can report its real context window before the occupancy
  // snapshot contains a limit. This is never a compaction-policy or static-model fallback.
  const measuredFallback = snapshot?.limitKind === 'context' && !snapshot.isStale && snapshot.limitTokens === undefined
    && reportedWindow !== null && reportedWindow > 0 ? reportedWindow : null
  const effectiveLimit = limit !== null && limit > 0 ? limit : measuredFallback
  return { used, limit: effectiveLimit, modelWindow: modelWindow !== null && modelWindow > 0 ? modelWindow : null,
    percent: used !== null && effectiveLimit !== null ? Math.round(used / effectiveLimit * 100) : null,
    stale: snapshot?.isStale ?? false, estimate: snapshot?.isEstimate ?? false }
}
