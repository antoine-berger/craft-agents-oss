import type { ContextUsageSnapshot } from '@craft-agent/core/types'

const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

export interface ContextIndicatorSettings {
  enable1MContext: boolean
  autoCompactWindow: number | null
}

/** Only the latest backend occupancy snapshot participates; billing totals never do. */
export function contextIndicatorValues(snapshot?: ContextUsageSnapshot, modelContextWindow?: number | null, reportedContextWindow?: number | null, settings?: ContextIndicatorSettings) {
  const used = count(snapshot?.usedTokens)
  const limit = count(snapshot?.limitTokens)
  const modelWindow = count(modelContextWindow)
  const reportedWindow = count(reportedContextWindow)
  // First-turn SDK usage can report its real context window before the occupancy
  // snapshot contains a limit. This is never a compaction-policy or static-model fallback.
  const measuredFallback = snapshot?.limitKind === 'context' && !snapshot.isStale && snapshot.limitTokens === undefined
    && reportedWindow !== null && reportedWindow > 0 ? reportedWindow : null
  const backendLimit = limit !== null && limit > 0 ? limit : measuredFallback
  const capacity = modelWindow !== null && modelWindow > 0 ? modelWindow : null
  const contextWindow = settings?.enable1MContext && capacity !== null
    ? capacity
    : reportedWindow !== null && reportedWindow > 0 ? reportedWindow
    : snapshot?.limitKind === 'context' ? backendLimit : null
  const configuredThreshold = count(settings?.autoCompactWindow)
  const compactionThreshold = configuredThreshold !== null && configuredThreshold > 0
    ? contextWindow !== null ? Math.min(configuredThreshold, contextWindow) : configuredThreshold
    : null
  const effectiveLimit = compactionThreshold ?? (settings?.enable1MContext ? contextWindow : null) ?? backendLimit
  const limitKind = compactionThreshold !== null ? 'compaction' : settings?.enable1MContext && contextWindow !== null ? 'context' : snapshot?.limitKind ?? 'context'
  return { used, limit: effectiveLimit, limitKind, contextWindow, modelWindow: capacity,
    percent: used !== null && effectiveLimit !== null ? Math.round(used / effectiveLimit * 100) : null,
    stale: snapshot?.isStale ?? false, estimate: snapshot?.isEstimate ?? false }
}
