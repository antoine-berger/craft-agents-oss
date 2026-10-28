/**
 * When the PR watcher polls next. Pure, so the whole table is unit-tested.
 *
 * Polling is the floor; most updates come from triggers (agent turn end, `.git` ref changes, the
 * card's Refresh, re-subscribing when a window shows), which refresh at once.
 */

import type { PrWatchState } from '@craft-agent/shared/protocol'

export const POLL = {
  /** A PR displayed in a chat header. */
  foreground: 5_000,
  /** Sidebar/attention watchers share the budget with the displayed chat. */
  background: 5 * 60_000,
  /** First retry after an error; doubles per consecutive error */
  errorBase: 30_000,
  errorMax: 10 * 60_000,
  /** Below this many GraphQL points left, wait for the reset */
  rateLimitFloor: 200,
} as const

export interface ScheduleInput {
  state: PrWatchState
  foreground?: boolean
  now: number
  consecutiveErrors: number
  rateLimit?: { remaining: number; resetAt: number }
}

/** Milliseconds until the next poll, or `null` to stop polling (triggers still refresh). */
export function nextPollDelay({ state, foreground = false, now, consecutiveErrors, rateLimit }: ScheduleInput): number | null {
  let delay: number | null
  if (consecutiveErrors > 0) {
    delay = Math.min(POLL.errorBase * 2 ** (consecutiveErrors - 1), POLL.errorMax)
  } else if (state.kind === 'none' || state.kind === 'loading') {
    delay = foreground ? POLL.foreground : POLL.background
  } else if (state.kind === 'unavailable') {
    // Not a repo, not GitHub, no credential: nothing to poll until something re-subscribes
    delay = null
  } else {
    const { summary } = state
    if (summary.state === 'merged' || summary.state === 'closed') delay = null
    else if (foreground) delay = POLL.foreground
    else delay = POLL.background
  }
  if (delay !== null && rateLimit && rateLimit.remaining < POLL.rateLimitFloor && rateLimit.resetAt > now) {
    delay = Math.max(delay, rateLimit.resetAt - now)
  }
  return delay
}
