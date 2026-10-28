import { expect, it } from 'bun:test'
import { PrWatchSnapshots } from '../pr-watch-snapshots'
import type { PrEntry } from '@craft-agent/shared/protocol'
import { nextPrQuickAction } from '../../components/app-shell/chat-header/pr-watch/pr-quick-actions'

const entry: PrEntry = { id: 'repo#1', origin: 'branch', summary: {
  number: 1, title: 'PR', url: 'https://github.com/a/b/pull/1', state: 'open', headRef: 'feature', baseRef: 'main',
  checks: 'success', reviewDecision: 'approved', mergeState: 'clean', unresolvedThreads: 0,
  localAhead: 0, localDirty: false, headMatchesLocal: true, fetchedAt: 1, via: 'gh',
  quickActions: { canMerge: true, methods: ['squash'], defaultMethod: 'squash', mergeQueue: false },
} }
it('keeps a known PR visible during reconnects and errors without permitting a cached merge', () => {
  const cache = new PrWatchSnapshots()
  const fresh = cache.update('session:checkout', { kind: 'ready', prs: [entry] })
  expect(fresh.kind).toBe('ready')
  for (const next of [{ kind: 'loading' }, { kind: 'unavailable', reason: 'error' }] as const) {
    const state = cache.update('session:checkout', next)
    expect(state.kind).toBe('ready')
    if (state.kind !== 'ready') throw new Error('PR disappeared')
    expect(state.prs[0]!.summary.attentionStale).toBe(true)
    expect(nextPrQuickAction({ kind: 'pr', summary: state.prs[0]!.summary }, 'branch')).toBeNull()
  }
  const restored = cache.update('session:checkout', { kind: 'ready', prs: [entry] })
  if (restored.kind !== 'ready') throw new Error('Expected ready')
  expect(nextPrQuickAction({ kind: 'pr', summary: restored.prs[0]!.summary }, 'branch')).toBe('merge')
})
it('never carries a PR between chats or checkouts and honors confirmed removal', () => {
  const cache = new PrWatchSnapshots()
  cache.update('chat:old-dir', { kind: 'ready', prs: [entry] })
  expect(cache.read('chat:new-dir').kind).toBe('loading')
  expect(cache.read('other:old-dir').kind).toBe('loading')
  expect(cache.update('chat:old-dir', { kind: 'none' }).kind).toBe('none')
  expect(cache.read('chat:old-dir').kind).toBe('loading')
  cache.update('chat:old-dir', { kind: 'ready', prs: [entry] })
  expect(cache.update('chat:old-dir', { kind: 'unavailable', reason: 'not-git' }).kind).toBe('unavailable')
})
