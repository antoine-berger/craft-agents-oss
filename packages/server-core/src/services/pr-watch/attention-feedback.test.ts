import { describe, expect, it } from 'bun:test'
import { mapAttentionFeedback, mapSummary } from './map-github'
import type { GqlPullRequestSummary } from './github-queries'
const HEAD = 'a1234567890123456789012345678901234567890'
const node = (overrides: Partial<GqlPullRequestSummary> = {}): GqlPullRequestSummary => ({ id: 'pr', number: 1, title: 'Task', url: 'https://github.com/a/b/pull/1', state: 'OPEN', isDraft: false, headRefName: 'me/task', baseRefName: 'main', headRefOid: HEAD, headRepositoryOwner: { login: 'a' }, reviewDecision: null, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', autoMergeRequest: null, viewerCanEnableAutoMerge: false, baseRepository: null, commits: { nodes: [{ commit: { committedDate: '2026-10-20T10:00:00Z', statusCheckRollup: { state: 'SUCCESS' } } }] }, reviewThreads: { nodes: [] }, ...overrides })
describe('current human and bot review evidence', () => {
  it('includes unresolved current threads from humans, Devin and CodeRabbit; excludes outdated/resolved', () => {
    const n = node({ reviewThreads: { nodes: [
      { id: '1', isResolved: false, isOutdated: false, comments: { nodes: [{ author: { login: 'devin-ai-integration[bot]' }, url: 'https://github.com/a/b/pull/1#r1' }] } },
      { id: '2', isResolved: false, isOutdated: true }, { id: '3', isResolved: true, isOutdated: false },
    ] } })
    expect(mapAttentionFeedback(n).map(r => r.id)).toEqual(['thread:1'])
    expect(mapAttentionFeedback(n)[0]?.author).toBe('devin-ai-integration[bot]')
  })
  it('requires CHANGES_REQUESTED to be on exact current commit, including a human reviewer', () => {
    const review = { id: 'R', state: 'CHANGES_REQUESTED', body: '', url: 'https://github.com/a/b/pull/1#review', author: { login: 'human' }, commit: { oid: HEAD } }
    expect(mapAttentionFeedback(node({ latestOpinionatedReviews: { nodes: [review] } }))).toHaveLength(1)
    expect(mapAttentionFeedback(node({ latestOpinionatedReviews: { nodes: [{ ...review, commit: { oid: 'old-head' } }] } }))).toEqual([])
  })
  it('bot summaries need explicit positive findings and exact reviewed commit', () => {
    const review = { id: 'R', state: 'COMMENTED', body: 'Actionable comments posted: **2**', url: 'https://github.com/a/b/pull/1#review', author: { login: 'coderabbitai[bot]' }, commit: { oid: HEAD } }
    expect(mapAttentionFeedback(node({ latestOpinionatedReviews: { nodes: [review] } }))).toHaveLength(1)
    for (const body of ['Anything else?', 'Found 5 files', 'Actionable comments posted: 0']) expect(mapAttentionFeedback(node({ latestOpinionatedReviews: { nodes: [{ ...review, body }] } }))).toEqual([])
    const comment = { id: 'C', body: `Found 2 potential issues on ${HEAD}`, url: 'https://github.com/a/b/pull/1#comment', createdAt: '2026-10-20T11:00:00Z', author: { login: 'devin-ai-integration[bot]' } }
    expect(mapAttentionFeedback(node({ comments: { nodes: [comment] } }))).toHaveLength(1)
    expect(mapAttentionFeedback(node({ comments: { nodes: [{ ...comment, body: 'Found 2 potential issues' }] } }))).toEqual([])
  })
  it('marks truncated thread evidence as unknown, so confirmed requests cannot be silently cleared', () => {
    const summary = mapSummary(node({ reviewThreads: { pageInfo: { hasNextPage: true }, nodes: [] } }), { localAhead: 0, localDirty: false }, { fetchedAt: 1, via: 'gh' })
    expect(summary.attentionStale).toBe(true)
  })
})
