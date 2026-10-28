import { describe, expect, it } from 'bun:test'
import type { PrSummary, PrWatchState } from '@craft-agent/shared/protocol'
import { nextPollDelay, POLL } from './schedule'

const summary: PrSummary = {
  number: 1, title: 't', url: 'u', state: 'open', headRef: 'h', baseRef: 'main', checks: 'success',
  reviewDecision: 'none', mergeState: 'clean', unresolvedThreads: 0, localAhead: 0, localDirty: false,
  fetchedAt: 0, via: 'gh',
}
const pr = (overrides: Partial<PrSummary> = {}): PrWatchState => ({ kind: 'pr', summary: { ...summary, ...overrides } })
const NOW = 1_000_000_000
const at = (state: PrWatchState, extra: Partial<Parameters<typeof nextPollDelay>[0]> = {}) =>
  nextPollDelay({ state, now: NOW, consecutiveErrors: 0, ...extra })

describe('nextPollDelay', () => {
  it('keeps background CI checks within the shared budget', () => {
    expect(at(pr({ checks: 'pending' }))).toBe(POLL.background)
  })

  it('polls background PRs every five minutes regardless of their checks', () => {
    for (const checks of ['pending', 'success', 'failure', 'none'] as const) {
      expect(at(pr({ checks }))).toBe(300_000)
    }
  })

  it('stops for merged and closed PRs and when the watcher cannot run', () => {
    expect(at(pr({ state: 'merged' }))).toBeNull()
    expect(at(pr({ state: 'closed' }))).toBeNull()
    expect(at({ kind: 'unavailable', reason: 'not-git' })).toBeNull()
    expect(at({ kind: 'unavailable', reason: 'no-token' })).toBeNull()
  })

  it('keeps looking for a PR on a branch without one', () => {
    expect(at({ kind: 'none' })).toBe(POLL.background)
  })

  it('backs off exponentially on errors, capped', () => {
    expect(at(pr(), { consecutiveErrors: 1 })).toBe(30_000)
    expect(at(pr(), { consecutiveErrors: 3 })).toBe(120_000)
    expect(at(pr(), { consecutiveErrors: 20 })).toBe(POLL.errorMax)
  })

  it('waits for the rate-limit reset when the budget runs low', () => {
    const resetAt = NOW + 20 * 60_000
    expect(at(pr({ checks: 'pending' }), { rateLimit: { remaining: 50, resetAt } })).toBe(20 * 60_000)
    expect(at(pr({ checks: 'pending' }), { rateLimit: { remaining: 4000, resetAt } })).toBe(POLL.background)
  })
})

describe('foreground polling', () => {
  it('uses five seconds for displayed PRs while preserving background pacing', () => {
    expect(at(pr(), { foreground: true })).toBe(5_000)
    expect(at(pr())).toBe(POLL.background)
    expect(at(pr({ checks: 'pending' }), { foreground: true })).toBe(5_000)
  })
  it('retains error, quota and terminal-state safeguards in the foreground', () => {
    expect(at(pr(), { foreground: true, consecutiveErrors: 1 })).toBe(POLL.errorBase)
    expect(at(pr(), { foreground: true, rateLimit: { remaining: 5, resetAt: NOW + 60_000 } })).toBe(60_000)
    expect(at(pr({ state: 'merged' }), { foreground: true })).toBeNull()
  })
 })
