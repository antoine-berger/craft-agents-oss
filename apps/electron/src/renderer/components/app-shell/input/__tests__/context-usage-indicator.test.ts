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
  it('uses a measured backend context window on the first turn while the SDK snapshot limit is late', () => {
    const firstTurn = snapshot(63_769, { limitTokens: undefined, limitKind: 'context', isEstimate: true })
    expect(contextIndicatorValues(firstTurn, 200_000, 1_000_000)).toMatchObject({ used: 63_769, limit: 1_000_000, percent: 6, estimate: true })
    expect(contextIndicatorValues({ ...firstTurn, limitTokens: 500_000 }, 200_000, 1_000_000)).toMatchObject({ limit: 500_000, percent: 13 })
  })
  it('never uses the measured fallback for compaction policy, stale snapshots or static capacity alone', () => {
    const missing = snapshot(63_769, { limitTokens: undefined })
    expect(contextIndicatorValues(missing, 1_000_000, 1_000_000)).toMatchObject({ limit: null, percent: null })
    expect(contextIndicatorValues({ ...missing, limitKind: 'context', isStale: true }, 1_000_000, 1_000_000)).toMatchObject({ limit: null, percent: null })
    expect(contextIndicatorValues({ ...missing, limitKind: 'context' }, 1_000_000)).toMatchObject({ limit: null, percent: null })
    expect(contextIndicatorValues(undefined, 1_000_000, 1_000_000)).toMatchObject({ limit: null, percent: null })
    for (const reported of [0, -1, NaN, Infinity]) expect(contextIndicatorValues({ ...missing, limitKind: 'context' }, 1_000_000, reported).percent).toBeNull()
  })
})
