import type { ContextUsageSnapshot } from '@craft-agent/core/types'

const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

/** Only the latest backend occupancy snapshot participates; billing totals never do. */
export function contextIndicatorValues(snapshot?: ContextUsageSnapshot, modelContextWindow?: number | null) {
  const used = count(snapshot?.usedTokens)
  const limit = count(snapshot?.limitTokens)
  const modelWindow = count(modelContextWindow)
  const effectiveLimit = limit !== null && limit > 0 ? limit : null
  return { used, limit: effectiveLimit, modelWindow: modelWindow !== null && modelWindow > 0 ? modelWindow : null,
    percent: used !== null && effectiveLimit !== null ? Math.round(used / effectiveLimit * 100) : null,
    stale: snapshot?.isStale ?? false, estimate: snapshot?.isEstimate ?? false }
}
