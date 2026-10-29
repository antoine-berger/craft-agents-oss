/**
 * The Coding-mode PR chip's data. A session tracks its branch's PR plus any bound PRs (pr_bind), and
 * the chip shows them as a carousel. This hook subscribes to the workspace server's PR watcher while
 * `enabled` and the window is visible, applies its `prWatch:changed` pushes (the whole PR set for the
 * session), holds the active carousel index, and loads the active PR's card details while the card is
 * open.
 *
 * It exposes the ACTIVE entry as a {@link PrWatchState} so the chip renders one PR exactly as before,
 * plus `nav` (the active index, every PR for the card's tabs, and `onSelect`) and the unbind /
 * auto-merge / auto-fix actions the card uses.
 * Unsubscribing when hidden is what pauses polling; re-subscribing when shown refreshes at once.
 */

import * as React from 'react'
import { PrWatchSnapshots } from './pr-watch-snapshots'
import type { PrDetails, PrEntry, PrMergeMethod, PrSummary, PrWatchSessionState, PrWatchState } from '@craft-agent/shared/protocol'

/** While the card is open, its details are re-read this often (the server caches them for 10 s). */
const DETAILS_REFRESH_MS = 15_000
/** A Refresh that gets no push back (nothing changed) stops spinning after this long. */
const REFRESH_SPINNER_MAX_MS = 10_000

/** One PR of the session's set, as the card's tabs show it. */
export interface PrNavEntry {
  id: string
  origin: PrEntry['origin']
  summary: PrSummary
}

export interface PrWatchNav {
  /** Active index into the carousel (0-based) */
  index: number
  /** Total PRs in the carousel */
  count: number
  /** Every PR in carousel order (the branch PR first, then pinned ones): the card's tabs */
  entries: PrNavEntry[]
  /** Make another PR the active one (a tab, the "+N" menu, ←/→ in the card) */
  onSelect: (index: number) => void
}

/** What changing auto-merge came back with: a refusal is `ok: false`, with GitHub's reason when there is one */
export interface PrAutoMergeChange {
  ok: boolean
  error?: string
}

/** Auto-fix (the card's Fix toggle) for the active PR. */
export interface PrAutoFixView {
  enabled: boolean
  /** Epoch ms of the last auto-fix run, when one ran */
  lastRunAt?: number
}

export interface PrWatch {
  /** The active entry as a single-PR state, so the chip renders it exactly as before */
  state: PrWatchState
  /** The session's PRs and which one is active; `count <= 1` means no tabs or "+N" */
  nav: PrWatchNav
  /** Where the active PR came from (the branch PR can't be unbound) */
  activeOrigin: PrEntry['origin'] | undefined
  refresh: () => void
  onCardOpenChange: (open: boolean) => void
  /** Remove the active (bound) PR from the session; ref is the PR URL */
  unbind: (ref: string) => void
  /** Enable/disable GitHub auto-merge on the active PR; ref is the PR URL. Resolves with GitHub's answer */
  setAutoMerge: (ref: string, enabled: boolean, method?: PrMergeMethod) => Promise<PrAutoMergeChange>
  /** Auto-fix for the active PR (server-held: it keeps running while this window is hidden) */
  autoFix: PrAutoFixView
  /** Turn auto-fix on/off for the active PR */
  setAutoFix: (enabled: boolean) => void
}

const snapshots = new PrWatchSnapshots()

function useDocumentVisible(): boolean {
  const [visible, setVisible] = React.useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  React.useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return visible
}

const NO_ENTRIES: PrEntry[] = []

/** The aggregate's entries, or none (one stable array, so `nav` stays memoized) for a non-ready state. */
function entriesOf(state: PrWatchSessionState): PrEntry[] {
  return state.kind === 'ready' ? state.prs : NO_ENTRIES
}

export function usePrWatch(sessionId: string, enabled: boolean, workingDirectory: string | undefined, foreground = true): PrWatch {
  const visible = useDocumentVisible()
  const snapshotKey = JSON.stringify([sessionId, workingDirectory])
  // Tag by checkout too: a folder change must never expose the previous branch's actions.
  const [tagged, setTagged] = React.useState<{ key: string; state: PrWatchSessionState }>(() => ({ key: snapshotKey, state: snapshots.read(snapshotKey) }))
  const base = tagged.key === snapshotKey ? tagged.state : snapshots.read(snapshotKey)
  const setBase = React.useCallback((next: PrWatchSessionState | ((current: PrWatchSessionState) => PrWatchSessionState)) => {
    setTagged(current => {
      const currentState = current.key === snapshotKey ? current.state : snapshots.read(snapshotKey)
      const value = typeof next === 'function' ? next(currentState) : next
      return { key: snapshotKey, state: snapshots.update(snapshotKey, value) }
    })
  }, [snapshotKey])
  const [activeIndex, setActiveIndex] = React.useState(0)
  const [details, setDetails] = React.useState<{ key: string; value: PrDetails } | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const [cardOpen, setCardOpen] = React.useState(false)
  const [retry, setRetry] = React.useState(0)
  const subscribed = React.useRef(false)
  const active = enabled && visible

  const entries = entriesOf(base)
  // Clamp the active index into range (bound PRs come and go); stays put otherwise.
  const index = entries.length === 0 ? 0 : Math.min(activeIndex, entries.length - 1)
  const activeEntry = entries[index]
  const countRef = React.useRef(0)
  countRef.current = entries.length

  // Restore only the current checkout while its subscription is being established.
  React.useEffect(() => {
    setBase(snapshots.read(snapshotKey))
    setDetails(null)
    setActiveIndex(0)
  }, [setBase, enabled, snapshotKey])

  React.useEffect(() => {
    return window.electronAPI?.onReconnected?.(() => {
      subscribed.current = false
      setRetry(value => value + 1)
    })
  }, [])

  React.useEffect(() => {
    const api = window.electronAPI
    if (!active || !api?.prWatchSubscribe) return
    let cancelled = false
    let subscriptionId: string | null = null
    let pushed: PrWatchSessionState | null = null
    const off = api.onPrWatchChanged((changedSessionId, state) => {
      if (cancelled || changedSessionId !== sessionId) return
      if (state.kind === 'loading' && pushed) return
      if (state.kind !== 'loading') pushed = state
      setBase(state)
      setRefreshing(false)
    })
    const refetchOnFocus = () => {
      if (foreground && !cancelled && document.visibilityState !== 'hidden' && subscriptionId) {
        void api.prWatchRefresh?.(sessionId, true).catch(() => {})
      }
    }
    window.addEventListener('focus', refetchOnFocus)
    api.prWatchSubscribe(sessionId, foreground).then(
      (result) => {
        if (cancelled) {
          if (result.subscriptionId) void api.prWatchUnsubscribe(result.subscriptionId)
          return
        }
        subscriptionId = result.subscriptionId
        subscribed.current = !!subscriptionId
        // Reconcile the opened chat while respecting quota and error backoff.
        // Sidebar rows share the background poll and never force a request on entry/focus.
        if (foreground && subscriptionId) void api.prWatchRefresh?.(sessionId, true).catch(() => {})
        if (!pushed) {
          setBase(result.state)
        } else if (pushed.kind === 'ready' && pushed.incomplete && result.state.kind === 'ready') {
          // A bound PR can push before the branch attaches. Retain the completed set,
          // but keep newer per-PR updates received while subscribe was in flight.
          const branchId = pushed.prs.find(entry => entry.origin === 'branch')?.id
          const entries = new Map(result.state.prs
            .filter(entry => !branchId || entry.origin !== 'branch' || entry.id === branchId)
            .map(entry => [entry.id, entry]))
          for (const entry of pushed.prs) {
            const previous = entries.get(entry.id)
            if (!previous
              || (entry.origin === 'branch' && previous.origin === 'bound')
              || (entry.origin === previous.origin && entry.summary.fetchedAt >= previous.summary.fetchedAt)) {
              entries.set(entry.id, entry)
            }
          }
          const prs = [...entries.values()].sort((a, b) => a.origin === b.origin ? 0 : a.origin === 'branch' ? -1 : 1)
          setBase({ ...result.state, prs })
        }
      },
      () => {
        if (!cancelled && !pushed) setBase({ kind: 'unavailable', reason: 'error' })
      },
    )
    return () => {
      cancelled = true
      subscribed.current = false
      window.removeEventListener('focus', refetchOnFocus)
      off()
      if (subscriptionId) void api.prWatchUnsubscribe(subscriptionId)
    }
  }, [active, sessionId, workingDirectory, setBase, retry, foreground])

  // Details belong to one PR (kept on screen across pushes so the card doesn't flash skeletons);
  // each push re-reads them while the card is open. Keyed by the active entry's id.
  const detailsKey = activeEntry?.id ?? null
  const pushedAt = activeEntry?.summary.fetchedAt ?? 0
  React.useEffect(() => {
    const api = window.electronAPI
    if (!active || !cardOpen || !detailsKey || !api?.prWatchGetDetails) return
    let cancelled = false
    const load = () => {
      api.prWatchGetDetails(sessionId, detailsKey).then(
        (value) => {
          if (!cancelled && value) setDetails({ key: detailsKey, value })
        },
        () => {},
      )
    }
    load()
    const timer = setInterval(load, DETAILS_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [active, cardOpen, detailsKey, pushedAt, sessionId])

  React.useEffect(() => {
    if (!refreshing) return
    const timer = setTimeout(() => setRefreshing(false), REFRESH_SPINNER_MAX_MS)
    return () => clearTimeout(timer)
  }, [refreshing])

  const refresh = React.useCallback(() => {
    const api = window.electronAPI
    if (!api?.prWatchRefresh) return
    setRefreshing(true)
    if (!subscribed.current) setRetry(value => value + 1)
    void api.prWatchRefresh(sessionId).then(() => setRefreshing(false), () => setRefreshing(false))
  }, [sessionId])

  const unbind = React.useCallback((ref: string) => {
    void window.electronAPI?.prWatchUnbind?.(sessionId, ref)
  }, [sessionId])

  const setAutoMerge = React.useCallback(async (ref: string, enabled: boolean, method?: PrMergeMethod): Promise<PrAutoMergeChange> => {
    const api = window.electronAPI
    if (!api?.prWatchSetAutoMerge) return { ok: false }
    try {
      return await api.prWatchSetAutoMerge(sessionId, ref, enabled, method)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }, [sessionId])

  const activeId = activeEntry?.id
  const autoFixOn = !!activeEntry?.autoFix
  const autoFixLastRunAt = activeEntry?.autoFixLastRunAt
  const autoFix = React.useMemo<PrAutoFixView>(
    () => ({ enabled: autoFixOn, ...(autoFixLastRunAt ? { lastRunAt: autoFixLastRunAt } : {}) }),
    [autoFixOn, autoFixLastRunAt],
  )
  const setAutoFix = React.useCallback((enabled: boolean) => {
    if (!activeId) return
    void window.electronAPI?.prWatchSetAutoFix?.(sessionId, activeId, enabled)
  }, [sessionId, activeId])

  // Clamped against the live count without a stale closure.
  const onSelect = React.useCallback((next: number) => setActiveIndex(Math.max(0, Math.min(next, countRef.current - 1))), [])

  // The active entry as a single-PR state (what the chip renders); non-ready kinds pass through.
  const state = React.useMemo<PrWatchState>(() => {
    if (!activeEntry) {
      if (base.kind === 'ready') return { kind: 'none' } // ready but empty shouldn't happen; render nothing
      return base
    }
    return {
      kind: 'pr',
      summary: activeEntry.summary,
      details: details && details.key === activeEntry.id ? details.value : undefined,
      refreshing,
    }
  }, [base, activeEntry, details, refreshing])

  const navEntries = React.useMemo<PrNavEntry[]>(
    () => entries.map(entry => ({ id: entry.id, origin: entry.origin, summary: entry.summary })),
    [entries],
  )
  const nav = React.useMemo<PrWatchNav>(
    () => ({ index, count: navEntries.length, entries: navEntries, onSelect }),
    [index, navEntries, onSelect],
  )

  return { state, nav, activeOrigin: activeEntry?.origin, refresh, onCardOpenChange: setCardOpen, unbind, setAutoMerge, autoFix, setAutoFix }
}
