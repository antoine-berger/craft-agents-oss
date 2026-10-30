import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttentionReason } from '../../../../shared/src/protocol/session-attention'
import type { PrEntry, PrWatchSessionState } from '@craft-agent/shared/protocol'
import { SessionAttentionStore } from './store'
import { githubAttention, reconcileGithubAttention } from './github'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'craft-attention-')); roots.push(dir); return dir }
const reason = (id: string, source: AttentionReason['source'] = 'agent'): AttentionReason => ({ id, source, kind: source === 'permission' ? 'permission' : 'question', title: `Act on ${id}`, createdAt: 10, action: { type: 'session' } })
const entry = (summary: Partial<PrEntry['summary']> = {}, overrides: Partial<PrEntry> = {}): PrEntry => ({
  id: 'github.com/acme/test#1', origin: 'branch', summary: { number: 1, title: 'PR', url: 'https://github.com/acme/test/pull/1', state: 'open', headRef: 'me/task', baseRef: 'main', checks: 'success', reviewDecision: 'none', mergeState: 'clean', unresolvedThreads: 0, localAhead: 0, localDirty: false, fetchedAt: 1000, via: 'gh', headMatchesLocal: true, attentionFeedback: [], ...summary }, ...overrides,
})
const ready = (p: PrEntry): PrWatchSessionState => ({ kind: 'ready', prs: [p] })

describe('durable server attention', () => {
  it('keeps independent reasons, restarts durably and never treats reading as resolving', () => {
    const dir = root(); const store = new SessionAttentionStore('w', dir, () => 20)
    store.setWorking('s', true)
    store.setReasons('s', 'permission', [reason('permission:1', 'permission')])
    store.setReasons('s', 'agent', [reason('question')])
    expect(store.get('s')?.status).toBe('needs-human')
    const revision = store.snapshot().revision
    expect(store.snapshot().sessions.s?.reasons).toHaveLength(2)
    const restarted = new SessionAttentionStore('w', dir)
    expect(restarted.snapshot().revision).toBe(revision)
    expect(restarted.get('s')?.reasons).toHaveLength(2)
    expect(restarted.get('s')?.githubStale).toBe(true)
    restarted.setReasons('s', 'agent', [])
    expect(restarted.get('s')?.reasons.map(r => r.id)).toEqual(['permission:1'])
    restarted.setReasons('s', 'permission', [])
    expect(restarted.get('s')?.status).toBe('idle')
    expect(restarted.snapshot().revision).toBeGreaterThan(revision)
  })
  it('preserves confirmed GitHub requests on failed/stale refresh, then clears only with fresh evidence', () => {
    const store = new SessionAttentionStore('w', root())
    store.setReasons('s', 'github', [reason('review', 'github')])
    store.markGitHubStale('s')
    expect(store.get('s')?.reasons).toHaveLength(1)
    expect(store.get('s')?.githubStale).toBe(true)
    store.setReasons('s', 'github', [])
    expect(store.get('s')?.status).toBe('idle')
    expect(store.get('s')?.githubStale).toBe(false)
  })
  it('working is separate from unread and questions/plans/errors take precedence', () => {
    const store = new SessionAttentionStore('w', root())
    store.setWorking('s', true)
    expect(store.get('s')?.status).toBe('working')
    store.setReasons('s', 'agent', [reason('plan')])
    expect(store.get('s')?.status).toBe('needs-human')
    store.setReasons('s', 'agent', [])
    expect(store.get('s')?.status).toBe('working')
  })
  it('does not emit unchanged state on each polling tick', () => {
    const store = new SessionAttentionStore('w', root())
    let pushes = 0; const off = store.subscribe(() => pushes++)
    store.setReasons('s', 'agent', [reason('q')]); store.setReasons('s', 'agent', [reason('q')])
    expect(pushes).toBe(1)
    off(); store.forget('s'); expect(pushes).toBe(1)
  })
})

describe('GitHub attention evidence', () => {
  it('keeps source, exact action link and independent CI/review reasons', () => {
    const reasons = githubAttention(ready(entry({ checks: 'failure', attentionFeedback: [{ id: 'T1', author: 'coderabbitai[bot]', title: 'Unresolved review thread', url: 'https://github.com/acme/test/pull/1#discussion_r1' }] })), 1000)!
    expect(reasons.map(r => r.kind)).toEqual(['ci', 'review'])
    expect(reasons[1]?.title).toContain('coderabbitai')
    expect(reasons[1]?.action.url).toContain('#discussion_r1')
  })
  it('does not act on mismatched HEAD, old aggregate changes-requested or merged PRs', () => {
    expect(githubAttention(ready(entry({ checks: 'failure', headMatchesLocal: false })), 1000)).toEqual([])
    expect(githubAttention(ready(entry({ reviewDecision: 'changes_requested' })), 1000)).toEqual([])
    expect(githubAttention(ready(entry({ checks: 'failure', state: 'merged' })), 1000)).toEqual([])
  })
  it('unknown/unavailable/stale is not evidence that an existing request has gone away', () => {
    expect(githubAttention({ kind: 'unavailable', reason: 'error' }, 1000)).toBeNull()
    expect(githubAttention({ kind: 'ready', prs: [entry()], incomplete: true }, 1000)).toBeNull()
    expect(githubAttention(ready(entry({ attentionStale: true })), 1000)).toBeNull()
    expect(githubAttention(ready(entry({ headMatchesLocal: null })), 1000)).toBeNull()
    expect(githubAttention(ready(entry()), 1000 + 11 * 60_000)).toBeNull()
  })
  it('keeps event-driven attention current until reconciliation, but never overrides a known failure', () => {
    const p = entry({ checks: 'failure', freshUntil: 1000 + 61 * 60_000 })
    expect(githubAttention(ready(p), 1000 + 30 * 60_000)).toHaveLength(1)
    expect(githubAttention(ready(p), 1000 + 62 * 60_000)).toBeNull()
    p.summary.attentionStale = true
    expect(githubAttention(ready(p), 1000 + 30 * 60_000)).toBeNull()
  })
  it('suppresses only the specific active auto-fix PR; ordinary work or enabled toggle alone is insufficient', () => {
    const p = entry({ checks: 'failure' }, { autoFix: true })
    expect(githubAttention(ready(p), 1000, p.id)).toEqual([])
    expect(githubAttention(ready(p), 1000)).toHaveLength(1)
    expect(githubAttention(ready(p), 1000, 'other-pr')).toHaveLength(1)
  })
})

it('keeps failed PR lookup requests while adding fresh actionable feedback from another PR', () => {
  const previous = { ...reason('github:other/repo#2:ci', 'github'), kind: 'ci' as const }
  const result = reconcileGithubAttention({ kind: 'ready', prs: [entry({ checks: 'failure' })], incomplete: true }, [previous], 1000)
  expect(result.stale).toBe(true)
  expect(result.reasons.map(r => r.id)).toContain(previous.id)
  expect(result.reasons).toHaveLength(2)
})
