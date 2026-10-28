import { describe, expect, it } from 'bun:test'
import type { PrEntry, PrState, PrWatchSessionState } from '@craft-agent/shared/protocol'
import { deriveSessionStatus } from './derived-status'

function pr(state: PrState, origin: PrEntry['origin'] = 'branch'): PrEntry {
  return { id: origin, origin, summary: { state } } as PrEntry
}

describe('Conductor PR-derived session status', () => {
  it('keeps the current status when a durable association has not been refreshed', () => {
    const cached = pr('merged'); cached.summary.attentionStale = true
    expect(deriveSessionStatus({ kind: 'ready', prs: [cached] })).toBeUndefined()
  })
  it('maps no PR, open/draft, merged and closed PRs to the existing Craft status IDs', () => {
    expect(deriveSessionStatus({ kind: 'none' })).toBe('todo')
    for (const [state, expected] of Object.entries({ open: 'needs-review', draft: 'needs-review', merged: 'done', closed: 'cancelled' })) {
      expect(deriveSessionStatus({ kind: 'ready', prs: [pr(state as PrState)] })).toBe(expected)
    }
  })
  it('keeps the last status on missing credentials, loading or incomplete branch discovery', () => {
    const unknown: PrWatchSessionState[] = [
      { kind: 'loading' }, { kind: 'unavailable', reason: 'no-token' },
      { kind: 'ready', prs: [], incomplete: true },
    ]
    for (const state of unknown) expect(deriveSessionStatus(state)).toBeUndefined()
  })
  it('uses the branch PR, not another PR bound to the chat', () => {
    expect(deriveSessionStatus({ kind: 'ready', prs: [pr('closed', 'bound'), pr('open')] })).toBe('needs-review')
    expect(deriveSessionStatus({ kind: 'ready', prs: [pr('merged', 'bound')] })).toBe('todo')
    expect(deriveSessionStatus({ kind: 'ready', prs: [pr('merged')], incomplete: true })).toBe('done')
  })
})
