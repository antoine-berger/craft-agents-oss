import { describe, expect, it } from 'bun:test'
import { prIconState, type PrSummary } from '../chat-header/pr-watch/pr-watch-state'

const ready: PrSummary = {
  number: 1, title: 'Ready', url: 'https://github.com/example/repo/pull/1',
  state: 'open', headRef: 'feature', baseRef: 'main', checks: 'success',
  reviewDecision: 'approved', mergeState: 'clean', unresolvedThreads: 0,
  localAhead: 0, localDirty: false, fetchedAt: 1, via: 'gh',
}
const queued: PrSummary = { ...ready, quickActions: {
  canMerge: true, methods: ['squash'], defaultMethod: 'squash', mergeQueue: true,
  queued: { state: 'QUEUED', position: 2 },
} }

describe('PR status icon', () => {
  it('distinguishes a required rebase and an actual merge queue entry', () => {
    expect(prIconState({ ...ready, mergeState: 'behind' })).toBe('behind')
    expect(prIconState(queued)).toBe('queued')
    expect(prIconState({ ...queued, mergeState: 'behind' })).toBe('queued')
  })

  it('does not confuse queue support or auto-merge with queue membership', () => {
    expect(prIconState({ ...queued, quickActions: { ...queued.quickActions!, queued: undefined } })).toBe('open')
    expect(prIconState({ ...ready, autoMerge: { enabled: true } })).toBe('open')
  })

  it('preserves terminal and draft states and avoids stale queue claims', () => {
    for (const state of ['merged', 'closed', 'draft'] as const) {
      expect(prIconState({ ...queued, state, mergeState: 'behind' })).toBe(state)
    }
    expect(prIconState({ ...queued, attentionStale: true })).toBe('open')
    expect(prIconState({ ...ready, mergeState: 'behind', attentionStale: true })).toBe('open')
  })
})
