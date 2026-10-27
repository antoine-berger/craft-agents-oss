import { describe, expect, it } from 'bun:test'
import type { ContextUsageSnapshot } from '@craft-agent/core/types'
import { contextIndicatorValues } from '../context-usage-indicator-model'

const snapshot = (usedTokens: number | null, rest: Partial<ContextUsageSnapshot> = {}): ContextUsageSnapshot => ({ usedTokens, limitTokens: 200_000, limitKind: 'compaction', isEstimate: false, isStale: false, canCompact: true, ...rest })
describe('composer context indicator', () => {
  it('reflects current occupancy after compaction rather than accumulating tokens', () => {
    expect(contextIndicatorValues(snapshot(180_000)).percent).toBe(90)
    expect(contextIndicatorValues(snapshot(12_000)).percent).toBe(6)
    expect(contextIndicatorValues(snapshot(0)).percent).toBe(0)
  })
  it('uses the backend threshold and preserves advertised capacity separately', () => {
    expect(contextIndicatorValues(snapshot(419_000), 1_000_000)).toMatchObject({ used: 419_000, limit: 200_000, modelWindow: 1_000_000, percent: 210 })
  })
  it('does not reconstruct unknown snapshots from billing or model capacity', () => {
    const changed = Object.assign(snapshot(null, { limitTokens: undefined, isStale: true }), { inputTokens: 900_000 })
    expect(contextIndicatorValues(changed, 1_000_000)).toMatchObject({ used: null, limit: null, percent: null, stale: true })
    expect(contextIndicatorValues(undefined, 1_000_000)).toMatchObject({ used: null, limit: null, percent: null })
  })
  it('keeps estimates/stale explicit and rejects invalid numbers', () => {
    expect(contextIndicatorValues(snapshot(10_000, { isEstimate: true, isStale: true }))).toMatchObject({ estimate: true, stale: true, percent: 5 })
    for (const value of [NaN, Infinity, -1]) expect(contextIndicatorValues(snapshot(value, { limitTokens: value })).percent).toBeNull()
  })
})
