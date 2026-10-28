import { describe, expect, test } from 'bun:test'
import type { PrEntry, PrWatchSessionState } from '@craft-agent/shared/protocol'
import { syncSessionTitleFromPr } from './session-title'

const entry = (origin: PrEntry['origin'], title: string): PrEntry => ({
  id: `github.com/test/repo#${origin}`, origin,
  summary: { number: 1, title, url: 'https://github.com/test/repo/pull/1', state: 'open',
    headRef: 'me/task', baseRef: 'main', checks: 'success', reviewDecision: 'none',
    mergeState: 'clean', unresolvedThreads: 0, localAhead: 0, localDirty: false,
    fetchedAt: 1, via: 'cached' },
})
const ready = (...prs: PrEntry[]): PrWatchSessionState => ({ kind: 'ready', prs })
function harness(name = 'Old chat', archived = false) {
  const session = { id: 'chat', name, isArchived: archived }
  const renames: string[] = []
  const manager = {
    getSessionSnapshot: () => session as never,
    renameSession: async (_id: string, title: string) => { session.name = title; renames.push(title) },
  }
  return { session, renames, manager }
}

describe('chat titles follow the primary PR', () => {
  test('saved stale metadata cannot overwrite the current chat name', async () => {
    const h = harness('Current title'), cached = entry('branch', 'Old saved title')
    cached.summary.attentionStale = true
    await syncSessionTitleFromPr(h.manager, 'chat', ready(cached))
    expect(h.renames).toEqual([])
  })
  test('uses the exact branch PR title even when a dependency is listed first', async () => {
    const h = harness()
    const title = 'feat(outbound-http): shared door [SAP-4127] 🚪'
    await syncSessionTitleFromPr(h.manager, 'chat', ready(entry('bound', 'Dependency'), entry('branch', title)))
    expect(h.renames).toEqual([title])
  })
  test('updates again when the PR title changes, without rewriting an unchanged title', async () => {
    const h = harness()
    for (const title of ['First PR title', 'First PR title', 'Updated PR title']) {
      await syncSessionTitleFromPr(h.manager, 'chat', ready(entry('branch', title)))
    }
    expect(h.renames).toEqual(['First PR title', 'Updated PR title'])
  })
  test('uses one pinned PR, but does not choose arbitrarily between several', async () => {
    const h = harness()
    await syncSessionTitleFromPr(h.manager, 'chat', ready(entry('bound', 'Only PR')))
    await syncSessionTitleFromPr(h.manager, 'chat', ready(entry('bound', 'Dependency A'), entry('bound', 'Dependency B')))
    expect(h.renames).toEqual(['Only PR'])
  })
  test('missing, unavailable and empty titles preserve the current name', async () => {
    const h = harness()
    for (const state of [{ kind: 'loading' }, { kind: 'none' }, { kind: 'unavailable', reason: 'not-git' }, ready(entry('branch', '  '))] as PrWatchSessionState[]) {
      await syncSessionTitleFromPr(h.manager, 'chat', state)
    }
    expect(h.renames).toEqual([])
  })
  test('archived history can be renamed without unarchiving or starting it', async () => {
    const h = harness('Old archived title', true)
    await syncSessionTitleFromPr(h.manager, 'chat', ready(entry('branch', 'PR title')))
    expect(h.session).toEqual({ id: 'chat', name: 'PR title', isArchived: true })
  })
  test('a deleted session is ignored', async () => {
    const h = harness()
    await syncSessionTitleFromPr({ ...h.manager, getSessionSnapshot: () => null }, 'gone', ready(entry('branch', 'PR title')))
    expect(h.renames).toEqual([])
  })
})
