import { describe, expect, it } from 'bun:test'
import type { BoundPr, PrEntry, PrWatchSessionState } from '@craft-agent/shared/protocol'
import { GitHubRateLimitError, GitHubRequestError } from './github-client'
import type { GqlPullRequestSummary, GqlRepoMergeSettings } from './github-queries'
import type { LocalStatus, RepoInfo } from './local-git'
import { PrWatchRegistry, type PrWatchDeps } from './registry'
import { POLL } from './schedule'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diskPrAssociations, associatePr, type PrAssociationStore } from './association-store'

const REPO: RepoInfo = {
  root: '/work/app',
  gitDir: '/work/app/.git',
  commonDir: '/work/app/.git',
  branch: 'feat/x',
  pushRemote: 'origin',
  remoteBranch: 'feat/x',
  repo: { host: 'github.com', owner: 'acme', repo: 'app' },
  upstreamRepo: null,
}

/** A repository that allows auto-merge and every merge method, defaulting to squash for the viewer. */
const MERGE_SETTINGS: GqlRepoMergeSettings = {
  autoMergeAllowed: true, viewerDefaultMergeMethod: 'SQUASH', mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true,
}

const PR: GqlPullRequestSummary = {
  id: 'PR_7', number: 7, title: 'Feature X', url: 'https://github.com/acme/app/pull/7', state: 'OPEN', isDraft: false,
  headRefName: 'feat/x', baseRefName: 'main', headRefOid: 'abc', headRepositoryOwner: { login: 'acme' },
  reviewDecision: null, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', autoMergeRequest: null,
  viewerCanEnableAutoMerge: true, baseRepository: MERGE_SETTINGS,
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  reviewThreads: { nodes: [] },
}

/** A different PR in another repo, used for bound-PR (by-number) scenarios. */
const DEP_PR: GqlPullRequestSummary = {
  id: 'PR_42', number: 42, title: 'Bound dependency', url: 'https://github.com/other/dep/pull/42', state: 'OPEN', isDraft: false,
  headRefName: 'fix/y', baseRefName: 'main', headRefOid: 'def', headRepositoryOwner: { login: 'other' },
  reviewDecision: null, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', autoMergeRequest: null,
  viewerCanEnableAutoMerge: true, baseRepository: MERGE_SETTINGS,
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  reviewThreads: { nodes: [] },
}

const bound = (number: number, owner = 'other', repo = 'dep', host = 'github.com'): BoundPr => ({ host, owner, repo, number, addedAt: number })

/** The entries of a 'ready' aggregate, or [] otherwise. */
function entriesOf(state: PrWatchSessionState | undefined): PrEntry[] {
  return state?.kind === 'ready' ? state.prs : []
}
function firstPr(state: PrWatchSessionState | undefined): PrEntry | undefined {
  return entriesOf(state)[0]
}

describe('durable PR associations across cold starts', () => {
  it('restores an on-demand agent lookup from disk without creating a live watcher', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-pr-once-'))
    const input = { dir: '/work/app', workspaceRootPath: dir, boundPrs: [] }
    const warm = setup({ associations: diskPrAssociations })
    const cold = setup({ associations: diskPrAssociations })
    try {
      expect(firstPr(await warm.registry.fetchOnce(input))?.summary.number).toBe(7)
      warm.registry.dispose()
      cold.failNextWith(new GitHubRateLimitError(403, 60_000))
      expect(firstPr(await cold.registry.fetchOnce(input))).toMatchObject({ origin: 'branch', summary: { number: 7, attentionStale: true, checks: 'none' } })
      expect(cold.timers.size).toBe(0)
      expect(cold.registry.cachedSessionState('s1')).toBeNull()
    } finally { warm.registry.dispose(); cold.registry.dispose(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('restores the primary link before GitHub answers and keeps it through quota/network failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-pr-restart-'))
    const input = { ...sub(), workspaceRootPath: dir }
    const warm = setup({ associations: diskPrAssociations })
    try {
      await warm.registry.subscribe(input); await warm.flush(); warm.registry.dispose()
      for (const error of [new GitHubRateLimitError(403, 60_000), new GitHubRequestError('offline')]) {
        const cold = setup({ associations: { ...diskPrAssociations } })
        try {
          cold.failNextWith(error)
          const initial = await cold.registry.subscribe(input)
          expect(firstPr(initial.state)).toMatchObject({ origin: 'branch', summary: { number: 7, attentionStale: true } })
          await cold.flush()
          expect(firstPr(cold.registry.cachedSessionState('s1')!)).toMatchObject({ origin: 'branch',
            summary: { number: 7, headMatchesLocal: null, checks: 'none', mergeState: 'unknown', attentionStale: true } })
          expect(cold.calls[0]?.query).toContain('PrByNumber')
          await cold.advance(60_000)
          await cold.registry.nudge('s1')
          expect(firstPr(cold.registry.cachedSessionState('s1')!)?.summary.attentionStale).toBeUndefined()
        } finally { cold.registry.dispose() }
      }
    } finally { warm.registry.dispose(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('does not reuse a saved primary PR after a repository or branch switch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-pr-switch-'))
    const input = { ...sub(), workspaceRootPath: dir }
    const warm = setup({ associations: diskPrAssociations })
    try {
      await warm.registry.subscribe(input); await warm.flush(); warm.registry.dispose()
      for (const repo of [{ ...REPO, branch: 'new', remoteBranch: 'new' },
        { ...REPO, repo: { ...REPO.repo!, repo: 'another' } }]) {
        const cold = setup({ associations: diskPrAssociations, repos: { '/work/app': repo } })
        try {
          cold.failNextWith(new GitHubRequestError('offline'))
          const initial = await cold.registry.subscribe(input)
          expect(firstPr(initial.state)).toBeUndefined()
          await cold.flush()
          expect(firstPr(cold.registry.cachedSessionState('s1')!)).toBeUndefined()
        } finally { cold.registry.dispose() }
      }
    } finally { warm.registry.dispose(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('rediscovers a replacement PR when a saved PR closed while the backend was stopped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-pr-replaced-'))
    const input = { ...sub(), workspaceRootPath: dir }, warm = setup({ associations: diskPrAssociations })
    try {
      await warm.registry.subscribe(input); await warm.flush(); warm.registry.dispose()
      const next = { ...PR, id: 'PR_8', number: 8, url: 'https://github.com/acme/app/pull/8' }
      const cold = setup({ associations: diskPrAssociations, byNumber: { 7: { ...PR, state: 'CLOSED' } }, prs: [next] })
      try {
        await cold.registry.subscribe(input); await cold.flush()
        expect(firstPr(cold.registry.cachedSessionState('s1')!)?.summary.number).toBe(8)
        expect(firstPr(cold.registry.cachedSessionState('s1')!)?.summary.attentionStale).toBeUndefined()
      } finally { cold.registry.dispose() }
    } finally { warm.registry.dispose(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('rechecks a saved merged PR after a quota pause before stopping terminal polling', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-pr-terminal-')), input = { ...sub(), workspaceRootPath: dir, foreground: true }
    const merged = { ...PR, state: 'MERGED' as const }, warm = setup({ associations: diskPrAssociations, prs: [merged] })
    try {
      await warm.registry.subscribe(input); await warm.flush(); warm.registry.dispose()
      const limit = { remaining: 499, resetAt: new Date(1_060_000).toISOString() }
      const cold = setup({ associations: diskPrAssociations, prs: [merged], rateLimit: limit })
      try {
        await cold.registry.subscribe(input); await cold.flush()
        expect(firstPr(cold.registry.cachedSessionState('s1')!)?.summary.attentionStale).toBe(true)
        expect(cold.nextDelay()).toBe(60_000)
        limit.remaining = 4000; limit.resetAt = new Date(1_120_000).toISOString()
        await cold.advance(60_000)
        expect(firstPr(cold.registry.cachedSessionState('s1')!)?.summary.attentionStale).toBeUndefined()
        expect(cold.timers.size).toBe(0)
      } finally { cold.registry.dispose() }
    } finally { warm.registry.dispose(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('restores an explicitly pinned PR without confusing it with this checkout’s primary PR', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-pr-pinned-'))
    const input = { ...sub(), workspaceRootPath: dir, boundPrs: [bound(42)] }
    const warm = setup({ associations: diskPrAssociations, repos: { '/work/app': null } })
    try {
      await warm.registry.subscribe(input); await warm.flush(); warm.registry.dispose()
      const cold = setup({ associations: diskPrAssociations, repos: { '/work/app': null } })
      try {
        cold.failNextWith(new GitHubRateLimitError(403, 60_000))
        const initial = await cold.registry.subscribe(input)
        expect(firstPr(initial.state)).toMatchObject({ origin: 'bound', summary: { number: 42, attentionStale: true } })
      } finally { cold.registry.dispose() }
    } finally { warm.registry.dispose(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('ignores a mismatched saved record and tolerates an unwritable disk', async () => {
    const saved = associatePr(REPO.repo!, { ...PR, headRef: 'wrong' } as any)
    const t = setup({ associations: { load: () => saved, save: () => { throw new Error('disk full') } } })
    try {
      const initial = await t.registry.subscribe(sub())
      expect(firstPr(initial.state)).toBeUndefined()
      await t.flush()
      expect(firstPr(t.registry.cachedSessionState('s1')!)?.summary.number).toBe(7)
    } finally { t.registry.dispose() }
  })
})

function setup(options: { associations?: PrAssociationStore; repos?: Record<string, RepoInfo | null>; prs?: GqlPullRequestSummary[]; byNumber?: Record<number, GqlPullRequestSummary>; local?: LocalStatus; rateLimit?: { remaining: number; resetAt: string } } = {}) {
  let now = 1_000_000
  let nextTimer = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const pushes: Array<{ clientId: string; sessionId: string; state: PrWatchSessionState }> = []
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = []
  const refWatchers = new Map<string, () => void>()
  let stoppedRefWatchers = 0
  const repos: Record<string, RepoInfo | null> = { '/work/app': REPO, ...options.repos }
  let prs = options.prs ?? [PR]
  const byNumber = options.byNumber ?? { 42: DEP_PR }
  let failNext: Error | null = null
  let local = options.local ?? { localAhead: 0, localDirty: false }

  const deps: PrWatchDeps = {
    associations: options.associations,
    graphql: async <T,>(_host: string, _token: string, query: string, variables: Record<string, unknown>) => {
      calls.push({ query, variables })
      if (failNext) {
        const error = failNext
        failNext = null
        throw error
      }
      if (query.includes('PrDetails')) {
        return {
          rateLimit: null,
          repository: { pullRequest: {
            additions: 1, deletions: 2, changedFiles: 3,
            commits: { nodes: [{ commit: { oid: 'abc', messageHeadline: 'h', committedDate: '2026-10-17T00:00:00Z', author: { name: 'A', user: null }, statusCheckRollup: null } }] },
            latestOpinionatedReviews: { nodes: [] },
            reviewRequests: { nodes: [] },
          } },
        } as T
      }
      if (query.includes('mutation EnableAutoMerge')) {
        return { enablePullRequestAutoMerge: { pullRequest: { id: 'PR_7', autoMergeRequest: { mergeMethod: variables.method } } } } as T
      }
      if (query.includes('mutation DisableAutoMerge')) {
        return { disablePullRequestAutoMerge: { pullRequest: { id: 'PR_7', autoMergeRequest: null } } } as T
      }
      if (query.includes('PrReviewSignature')) {
        return {
          rateLimit: null,
          viewer: { login: 'Me' },
          repository: { pullRequest: {
            reviewThreads: { nodes: [
              // a collaborator's comment, then my reply: the collaborator's comment is the feedback
              { id: 'T1', isResolved: false, comments: { nodes: [{ id: 'C1', authorAssociation: 'COLLABORATOR', author: { login: 'rev' } }, { id: 'C2', authorAssociation: 'OWNER', author: { login: 'me' } }] } },
              // resolved: never feedback
              { id: 'T2', isResolved: true, comments: { nodes: [{ id: 'C3', authorAssociation: 'COLLABORATOR', author: { login: 'rev' } }] } },
              // only my own comments: not feedback
              { id: 'T3', isResolved: false, comments: { nodes: [{ id: 'C4', authorAssociation: 'OWNER', author: { login: 'me' } }] } },
              // a stranger on a public repo: never triggers auto-fix
              { id: 'T4', isResolved: false, comments: { nodes: [{ id: 'C5', authorAssociation: 'NONE', author: { login: 'stranger' } }] } },
            ] },
            latestOpinionatedReviews: { nodes: [
              { id: 'R1', state: 'CHANGES_REQUESTED', authorAssociation: 'MEMBER', author: { login: 'rev' } },
              { id: 'R2', state: 'APPROVED', authorAssociation: 'MEMBER', author: { login: 'x' } },
              { id: 'R3', state: 'CHANGES_REQUESTED', authorAssociation: 'OWNER', author: { login: 'me' } },
              { id: 'R4', state: 'CHANGES_REQUESTED', authorAssociation: 'CONTRIBUTOR', author: { login: 'drive-by' } },
            ] },
          } },
        } as T
      }
      if (query.includes('PrByNumber')) {
        const node = byNumber[variables.number as number] ?? prs.find(pr => pr.number === variables.number) ?? null
        return { rateLimit: options.rateLimit ?? { remaining: 4000, resetAt: '2030-01-01T00:00:00Z' }, repository: node ? { pullRequest: node } : { pullRequest: null } } as T
      }
      return { rateLimit: options.rateLimit ?? { remaining: 4000, resetAt: '2030-01-01T00:00:00Z' }, repository: { pullRequests: { nodes: prs } } } as T
    },
    candidates: async () => [{ id: 'gh', label: 'gh', getToken: async () => 'token' }],
    push: (clientId, sessionId, state) => pushes.push({ clientId, sessionId, state }),
    resolveRepo: async dir => repos[dir] ?? null,
    localStatus: async () => local,
    watchRefs: (repo, onChange) => {
      refWatchers.set(repo.root, onChange)
      return () => { stoppedRefWatchers++ }
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextTimer++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: handle => { timers.delete(handle as number) },
  }
  const registry = new PrWatchRegistry(deps)
  const flush = () => new Promise(r => setTimeout(r, 0))
  return {
    registry, pushes, calls, timers, refWatchers, repos,
    get stoppedRefWatchers() { return stoppedRefWatchers },
    setPrs: (next: GqlPullRequestSummary[]) => { prs = next },
    setLocal: (next: LocalStatus) => { local = next },
    failNextWith: (error: Error) => { failNext = error },
    flush,
    /** Advances the clock and runs due timers */
    async advance(ms: number) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.fn()
      }
      await flush()
      await flush()
    },
    nextDelay: () => Math.min(...[...timers.values()].map(t => t.at - now)),
  }
}

const sub = (sessionId = 's1', clientId = 'c1', dir = '/work/app', boundPrs: BoundPr[] = []) => ({ clientId, sessionId, dir, workspaceRootPath: '/ws', boundPrs })

describe('PrWatchRegistry gating', () => {
  it('never asks GitHub for a folder that is not a git repo', async () => {
    const t = setup({ repos: { '/tmp/notes': null } })
    const { state } = await t.registry.subscribe(sub('s1', 'c1', '/tmp/notes'))
    expect(state).toEqual({ kind: 'unavailable', reason: 'not-git' })
    expect(t.calls).toHaveLength(0)
    expect(t.timers.size).toBe(0)
  })

  it('shows nothing on a detached HEAD or a non-GitHub remote, without calls', async () => {
    const t = setup({ repos: {
      '/work/detached': { ...REPO, root: '/work/detached', branch: null, remoteBranch: null },
      '/work/gitlab': { ...REPO, root: '/work/gitlab', repo: null },
    } })
    expect((await t.registry.subscribe(sub('a', 'c1', '/work/detached'))).state).toEqual({ kind: 'none' })
    expect((await t.registry.subscribe(sub('b', 'c1', '/work/gitlab'))).state).toEqual({ kind: 'unavailable', reason: 'not-github' })
    expect(t.calls).toHaveLength(0)
  })

  it('reports none when the branch has no PR and keeps looking every five minutes', async () => {
    const t = setup({ prs: [] })
    await t.registry.subscribe(sub())
    await t.flush()
    expect(t.pushes.at(-1)?.state).toEqual({ kind: 'none' })
    expect(t.nextDelay()).toBe(POLL.background)
  })
})

describe('PrWatchRegistry fetching and pushing', () => {
  it('starts loading, then pushes the branch PR as a ready aggregate', async () => {
    const t = setup({ local: { localAhead: 1, localDirty: true } })
    const { state } = await t.registry.subscribe(sub())
    expect(state).toEqual({ kind: 'loading' })
    await t.flush()
    const pushed = t.pushes.at(-1)
    expect(pushed?.sessionId).toBe('s1')
    expect(pushed?.state.kind).toBe('ready')
    const entry = firstPr(pushed?.state)
    expect(entry?.origin).toBe('branch')
    expect(entry?.summary).toMatchObject({ number: 7, checks: 'success', localAhead: 1, localDirty: true, via: 'gh' })
    expect(t.calls[0]?.variables).toEqual({ owner: 'acme', name: 'app', branch: 'feat/x' })
    // Background sessions use the shared five-minute cadence.
    expect(t.nextDelay()).toBe(POLL.background)
  })

  it('shares one branch watcher between subscriptions and returns the current state to a newcomer', async () => {
    const t = setup()
    await t.registry.subscribe(sub('s1', 'c1'))
    await t.flush()
    // Same folder, second session/client: no new fetch, and the newcomer gets the ready state back.
    const second = await t.registry.subscribe(sub('s2', 'c2'))
    expect(t.calls).toHaveLength(1)
    expect(second.state.kind).toBe('ready')
    expect(firstPr(second.state)?.summary.number).toBe(7)
  })

  it('does not re-push an unchanged aggregate, but pushes changes', async () => {
    const t = setup()
    await t.registry.subscribe({ ...sub(), foreground: true })
    await t.flush()
    const count = t.pushes.length
    await t.advance(POLL.foreground)
    expect(t.calls).toHaveLength(2)
    expect(t.pushes.length).toBe(count)
    t.setPrs([{ ...PR, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }])
    await t.advance(POLL.foreground)
    expect(firstPr(t.pushes.at(-1)?.state)?.summary.checks).toBe('failure')
  })

  it('refetches at once on a nudge (agent turn end)', async () => {
    const t = setup()
    await t.registry.subscribe(sub())
    await t.flush()
    await t.registry.nudge('s1')
    expect(t.calls).toHaveLength(2)
  })

  it('keeps the last good state on errors and backs off', async () => {
    const t = setup()
    await t.registry.subscribe(sub())
    await t.flush()
    const count = t.pushes.length
    t.failNextWith(new GitHubRequestError('offline'))
    await t.registry.nudge('s1')
    expect(t.pushes.length).toBe(count + 1)
    expect(firstPr(t.pushes.at(-1)?.state)?.summary.attentionStale).toBe(true)
    expect(t.nextDelay()).toBe(POLL.errorBase)
  })

  it('hides the chip when the very first fetch fails', async () => {
    const t = setup()
    t.failNextWith(new GitHubRequestError('offline'))
    await t.registry.subscribe(sub())
    await t.flush()
    expect(t.pushes.at(-1)?.state).toEqual({ kind: 'unavailable', reason: 'error' })
  })

  it('honours Retry-After', async () => {
    const t = setup()
    await t.registry.subscribe(sub())
    await t.flush()
    t.failNextWith(new GitHubRequestError('rate limit', 403, 5 * 60_000))
    await t.registry.nudge('s1')
    expect(t.nextDelay()).toBe(5 * 60_000)
  })
})

describe('PrWatchRegistry bound PRs (multi-PR)', () => {
  it('resolves a bound PR by number and shows it after the branch PR', async () => {
    const t = setup()
    const { state } = await t.registry.subscribe(sub('s1', 'c1', '/work/app', [bound(42)]))
    expect(state).toEqual({ kind: 'loading' })
    await t.flush()
    const entries = entriesOf(t.pushes.at(-1)?.state)
    expect(entries.map(e => `${e.origin}:${e.summary.number}`)).toEqual(['branch:7', 'bound:42'])
    // The bound PR is fetched by number
    expect(t.calls.some(c => c.query.includes('PrByNumber') && c.variables.number === 42)).toBe(true)
  })

  it('dedupes a bound PR that is the branch PR (branch entry wins)', async () => {
    // Bind acme/app#7 — the same PR the branch already resolves.
    const t = setup({ byNumber: { 7: PR } })
    await t.registry.subscribe(sub('s1', 'c1', '/work/app', [bound(7, 'acme', 'app')]))
    await t.flush()
    const entries = entriesOf(t.pushes.at(-1)?.state)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ origin: 'branch', summary: { number: 7 } })
  })

  it('keeps a bound PR available when the folder is not a git repo (per-entry availability)', async () => {
    const t = setup({ repos: { '/tmp/notes': null } })
    await t.registry.subscribe(sub('s1', 'c1', '/tmp/notes', [bound(42)]))
    await t.flush()
    const entries = entriesOf(t.pushes.at(-1)?.state)
    expect(entries.map(e => `${e.origin}:${e.summary.number}`)).toEqual(['bound:42'])
  })

  it('setSessionBoundPrs adds and removes bound watchers live', async () => {
    const t = setup()
    await t.registry.subscribe(sub('s1', 'c1'))
    await t.flush()
    t.registry.setSessionBoundPrs('s1', [bound(42)])
    await t.flush()
    expect(entriesOf(t.pushes.at(-1)?.state).map(e => e.summary.number)).toEqual([7, 42])
    t.registry.setSessionBoundPrs('s1', [])
    await t.flush()
    expect(entriesOf(t.pushes.at(-1)?.state).map(e => e.summary.number)).toEqual([7])
  })

  it('verifyPr returns the summary for an existing PR and throws for a missing one', async () => {
    const t = setup()
    const summary = await t.registry.verifyPr({ coords: { host: 'github.com', owner: 'other', repo: 'dep' }, number: 42, workspaceRootPath: '/ws' })
    expect(summary).toMatchObject({ number: 42, title: 'Bound dependency' })
    await expect(
      t.registry.verifyPr({ coords: { host: 'github.com', owner: 'other', repo: 'dep' }, number: 999, workspaceRootPath: '/ws' }),
    ).rejects.toThrow(/not found/)
  })

  it('cachedSessionState returns a live aggregate only while subscribed (no fetch)', async () => {
    const t = setup()
    expect(t.registry.cachedSessionState('s1')).toBeNull()
    await t.registry.subscribe(sub('s1', 'c1'))
    await t.flush()
    const callsBefore = t.calls.length
    const cached = t.registry.cachedSessionState('s1')
    expect(firstPr(cached ?? undefined)?.summary.number).toBe(7)
    expect(t.calls).toHaveLength(callsBefore) // cache read triggers no GitHub call
  })

  it('setAutoMerge enables via GitHub and returns the new state', async () => {
    const t = setup()
    const state = await t.registry.setAutoMerge({ coords: { host: 'github.com', owner: 'acme', repo: 'app' }, number: 7, workspaceRootPath: '/ws', enabled: true, method: 'squash' })
    expect(state).toEqual({ enabled: true, method: 'squash' })
    expect(t.calls.some(c => c.query.includes('mutation EnableAutoMerge'))).toBe(true)
  })

  const ACME_7 = { coords: { host: 'github.com', owner: 'acme', repo: 'app' }, number: 7, workspaceRootPath: '/ws' }

  it('setAutoMerge says why GitHub won\'t take it, without trying the mutation', async () => {
    const t = setup({ byNumber: { 7: { ...PR, viewerCanEnableAutoMerge: false, baseRepository: { ...MERGE_SETTINGS, autoMergeAllowed: false } } } })
    const error = await t.registry.setAutoMerge({ ...ACME_7, enabled: true }).then(() => null, (e: Error) => e)
    expect(error?.message).toBe('Can\'t turn on auto-merge for acme/app #7: auto-merge is off for this repository (turn on "Allow auto-merge" in its GitHub settings).')
    expect(t.calls.some(c => c.query.includes('mutation EnableAutoMerge'))).toBe(false)
  })

  it('setAutoMerge uses the repository\'s default method and refuses one it has off', async () => {
    const noSquash = { ...MERGE_SETTINGS, viewerDefaultMergeMethod: 'MERGE' as const, squashMergeAllowed: false }
    const t = setup({ byNumber: { 7: { ...PR, baseRepository: noSquash } } })
    expect(await t.registry.setAutoMerge({ ...ACME_7, enabled: true })).toEqual({ enabled: true, method: 'merge' })
    expect(t.calls.find(c => c.query.includes('mutation EnableAutoMerge'))?.variables.method).toBe('MERGE')
    const error = await t.registry.setAutoMerge({ ...ACME_7, enabled: true, method: 'squash' }).then(() => null, (e: Error) => e)
    expect(error?.message).toBe('acme/app doesn\'t allow squash merges (it allows merge, rebase).')
  })
})

describe('PrWatchRegistry lifecycle', () => {
  it('stops polling and the ref watcher when the last subscriber leaves', async () => {
    const t = setup()
    const a = await t.registry.subscribe(sub('s1', 'c1'))
    const b = await t.registry.subscribe(sub('s1', 'c2'))
    await t.flush()
    t.registry.unsubscribe(a.subscriptionId)
    expect(t.timers.size).toBe(1)
    t.registry.unsubscribe(b.subscriptionId)
    expect(t.timers.size).toBe(0)
    expect(t.stoppedRefWatchers).toBe(1)
  })

  it('drops a disconnected client', async () => {
    const t = setup()
    await t.registry.subscribe(sub('s1', 'c1'))
    await t.flush()
    t.registry.dropClient('c1')
    expect(t.timers.size).toBe(0)
  })

  it('follows a branch switch seen by the ref watcher', async () => {
    const t = setup()
    await t.registry.subscribe(sub())
    await t.flush()
    t.repos['/work/app'] = { ...REPO, branch: 'feat/y', remoteBranch: 'feat/y' }
    t.setPrs([])
    t.refWatchers.get('/work/app')?.()
    await t.flush()
    await t.flush()
    expect(t.calls.at(-1)?.variables).toMatchObject({ branch: 'feat/y' })
    expect(t.pushes.at(-1)?.state).toEqual({ kind: 'none' })
    expect(t.stoppedRefWatchers).toBe(1)
  })
})

describe('PrWatchRegistry details', () => {
  const PR_ID = 'github.com/acme/app#7'

  it('fetches details once per 10 s and refreshes the local state', async () => {
    const t = setup()
    await t.registry.subscribe(sub())
    await t.flush()
    t.setLocal({ localAhead: 0, localDirty: true })
    const details = await t.registry.getDetails('s1', PR_ID, 'c1')
    expect(details).toMatchObject({ additions: 1, deletions: 2, changedFiles: 3, lastCommit: { sha: 'abc', author: 'A' } })
    expect(firstPr(t.pushes.at(-1)?.state)?.summary.localDirty).toBe(true)
    await t.registry.getDetails('s1', PR_ID, 'c1')
    expect(t.calls.filter(c => c.query.includes('PrDetails'))).toHaveLength(1)
  })

  it('returns null for an unknown entry id', async () => {
    const t = setup({ prs: [] })
    await t.registry.subscribe(sub())
    await t.flush()
    expect(await t.registry.getDetails('s1', PR_ID, 'c1')).toBeNull()
  })
})

describe('PrWatchRegistry auto-fix support', () => {
  const PR_ID = 'github.com/acme/app#7'

  it('stamps auto-fix onto entries and pushes when it changes', async () => {
    const t = setup()
    await t.registry.subscribe(sub())
    await t.flush()
    expect(firstPr(t.pushes.at(-1)?.state)?.autoFix).toBeUndefined()
    t.registry.setSessionMonitors('s1', { [PR_ID]: { autoFix: true, lastFixAt: 123 } })
    expect(firstPr(t.pushes.at(-1)?.state)).toMatchObject({ autoFix: true, autoFixLastRunAt: 123 })
    t.registry.setSessionMonitors('s1', {})
    expect(firstPr(t.pushes.at(-1)?.state)?.autoFix).toBeUndefined()
  })

  it('stamps auto-fix on the branch PR only, never on a pinned one', async () => {
    const t = setup()
    await t.registry.subscribe(sub('s1', 'c1', '/work/app', [bound(42)]))
    await t.flush()
    t.registry.setSessionMonitors('s1', { [PR_ID]: { autoFix: true }, 'github.com/other/dep#42': { autoFix: true } })
    const entries = entriesOf(t.pushes.at(-1)?.state)
    expect(entries.map(e => `${e.origin}:${e.autoFix ?? false}`)).toEqual(['branch:true', 'bound:false'])
  })

  it('dedupes a bound PR against the branch PR regardless of owner/repo case', async () => {
    const t = setup({ byNumber: { 7: PR } })
    await t.registry.subscribe(sub('s1', 'c1', '/work/app', [bound(7, 'Acme', 'App')]))
    await t.flush()
    const entries = entriesOf(t.pushes.at(-1)?.state)
    expect(entries.map(e => `${e.origin}:${e.id}`)).toEqual([`branch:${PR_ID}`])
  })

  it('builds the review signature from trusted reviewers\' open feedback only', async () => {
    const t = setup()
    const signature = await t.registry.fetchReviewSignature({ coords: { host: 'github.com', owner: 'acme', repo: 'app' }, number: 7, workspaceRootPath: '/ws' })
    expect(signature).toEqual(['r:R1', 't:T1:C1'])
  })
})

describe('server attention observers', () => {
  it('observes background sessions with no renderer and retains stale evidence on network failure', async () => {
    const t = setup()
    const states: PrWatchSessionState[] = []
    const off = t.registry.onSessionState((id, state) => { if (id === 'background') states.push(state) })
    await t.registry.subscribe(sub('background', '__session_attention__'))
    await t.flush()
    expect(firstPr(states.at(-1))?.summary.number).toBe(7)
    t.failNextWith(new GitHubRequestError('offline'))
    await t.registry.nudge('background')
    expect(firstPr(states.at(-1))?.summary.attentionStale).toBe(true)
    off(); const count = states.length
    await t.registry.nudge('background')
    expect(states).toHaveLength(count)
    t.registry.dispose()
    expect(t.timers.size).toBe(0)
  })
  it('caps concurrent GraphQL requests across all sessions at four and releases queued work', async () => {
    let active = 0; let peak = 0
    const release: Array<() => void> = []
    const registry = new PrWatchRegistry({
      graphql: async <T,>() => {
        active++; peak = Math.max(active, peak)
        await new Promise<void>(resolve => release.push(resolve))
        active--
        return { rateLimit: null, repository: { pullRequests: { nodes: [PR] } } } as T
      },
      candidates: async () => [{ id: 'gh', label: 'gh', getToken: async () => 'token' }],
      push: () => {}, resolveRepo: async dir => ({ ...REPO, root: dir }),
      localStatus: async () => ({ localAhead: 0, localDirty: false, headMatchesLocal: true }),
      watchRefs: () => () => {}, setTimer: () => 0, clearTimer: () => {},
    })
    try {
      for (let i = 0; i < 9; i++) await registry.subscribe(sub(`s${i}`, '__session_attention__', `/repo/${i}`))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(active).toBe(4)
      for (let i = 0; i < 9; i++) {
        release.shift()?.()
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      expect(active).toBe(0)
      expect(peak).toBe(4)
    } finally { registry.dispose(); for (const resolve of release) resolve() }
  })

  it('stops queued requests across all repositories when their shared credential hits its quota', async () => {
    let calls = 0
    const release: Array<() => void> = []
    const registry = new PrWatchRegistry({
      graphql: async () => {
        calls++
        await new Promise<void>(resolve => release.push(resolve))
        throw new GitHubRateLimitError(403, 600_000)
      },
      candidates: async () => [{ id: 'gh', label: 'gh', getToken: async () => 'same-token' }],
      push: () => {}, resolveRepo: async dir => ({ ...REPO, root: dir, repo: { ...REPO.repo!, repo: dir } }),
      watchRefs: () => () => {}, setTimer: () => 0, clearTimer: () => {}, now: () => 0,
    })
    try {
      for (let i = 0; i < 100; i++) await registry.subscribe(sub(`s${i}`, 'internal', `/repo/${i}`))
      expect(calls).toBe(4)
      for (const resolve of release) resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(calls).toBe(4)
      for (let i = 0; i < 100; i++) expect(registry.cachedSessionState(`s${i}`)).toEqual({ kind: 'unavailable', reason: 'error' })
    } finally { registry.dispose(); for (const resolve of release) resolve() }
  })
})

describe('foreground freshness', () => {
  it('detects a merge performed on GitHub within the next foreground poll', async () => {
    const t = setup()
    await t.registry.subscribe({ ...sub(), foreground: true })
    await t.flush()
    expect(t.nextDelay()).toBe(5_000)
    t.setPrs([{ ...PR, state: 'MERGED' }])
    await t.advance(5_000)
    expect(firstPr(t.pushes.at(-1)?.state)?.summary.state).toBe('merged')
    expect(t.timers.size).toBe(0)
    t.registry.dispose()
  })
  it('promotes an existing background watcher and restores its pace when the chat leaves', async () => {
    const t = setup()
    await t.registry.subscribe(sub('background', 'internal'))
    await t.flush()
    expect(t.nextDelay()).toBe(POLL.background)
    const foreground = await t.registry.subscribe({ ...sub(), foreground: true })
    expect(t.nextDelay()).toBe(5_000)
    t.registry.unsubscribe(foreground.subscriptionId)
    expect(t.nextDelay()).toBe(POLL.background)
    t.registry.dispose()
  })
  it('ignores a stale open snapshot of a merged PR, but accepts a new PR on the branch', async () => {
    const t = setup({ prs: [{ ...PR, state: 'MERGED' }] })
    await t.registry.subscribe(sub())
    await t.flush()
    t.setPrs([PR])
    await t.registry.nudge('s1')
    expect(firstPr(t.registry.cachedSessionState('s1')!)?.summary.state).toBe('merged')
    t.setPrs([{ ...PR, number: 8, url: 'https://github.com/acme/app/pull/8', id: 'PR_8' }])
    await t.registry.nudge('s1')
    expect(firstPr(t.registry.cachedSessionState('s1')!)?.summary.number).toBe(8)
    expect(firstPr(t.registry.cachedSessionState('s1')!)?.summary.state).toBe('open')
    t.registry.dispose()
  })
 })

it('automatic focus refresh honors Retry-After and error backoff', async () => {
  const t = setup()
  await t.registry.subscribe({ ...sub(), foreground: true })
  await t.flush()
  t.failNextWith(new GitHubRequestError('rate limited', 429, 60_000))
  await t.registry.nudge('s1')
  const count = t.calls.length
  await t.registry.nudge('s1', 'c1', true)
  expect(t.calls.length).toBe(count)
  expect(t.nextDelay()).toBe(60_000)
  await t.advance(60_000)
  expect(t.calls.length).toBe(count + 1)
  t.failNextWith(new GitHubRequestError('offline'))
  await t.registry.nudge('s1')
  const failed = t.calls.length
  await t.registry.nudge('s1', 'c1', true)
  expect(t.calls.length).toBe(failed)
  expect(t.nextDelay()).toBe(POLL.errorBase)
  t.registry.dispose()
})

it('automatic focus refresh respects the remaining GitHub quota', async () => {
  const t = setup({ rateLimit: { remaining: 5, resetAt: new Date(1_060_000).toISOString() } })
  await t.registry.subscribe({ ...sub(), foreground: true })
  await t.flush()
  expect(t.nextDelay()).toBe(60_000)
  const count = t.calls.length
  await t.registry.nudge('s1', 'c1', true)
  expect(t.calls.length).toBe(count)
  t.registry.dispose()
})

describe('Conductor PR polling', () => {
  it('discovers a branch once, then reads its known PR by number', async () => {
    const t = setup()
    try {
      await t.registry.subscribe({ ...sub(), foreground: true })
      await t.flush()
      await t.advance(POLL.foreground)
      await t.advance(POLL.foreground)
      expect(t.calls.map(call => call.query.includes('PrByNumber'))).toEqual([false, true, true])
      expect(t.calls[1]?.variables.number).toBe(7)
    } finally { t.registry.dispose() }
  })

  it('shares the low budget across chats and reserves requests for the visible chat', async () => {
    const limit = { remaining: 4000, resetAt: new Date(1_360_000).toISOString() }
    const t = setup({ rateLimit: limit })
    try {
      await t.registry.subscribe(sub('background', 'internal'))
      await t.flush()
      limit.remaining = 900
      await t.registry.subscribe({ ...sub('visible'), dir: '/work/visible', foreground: true })
      // Resolve a distinct branch watcher so the response updates the shared budget.
      t.repos['/work/visible'] = { ...REPO, root: '/work/visible' }
      await t.registry.nudge('visible')
      const count = t.calls.length
      await t.registry.nudge('background', 'internal', true)
      await t.registry.nudge('visible', 'c1', true)
      expect(t.calls.length).toBe(count)
      await t.advance(60_000)
      expect(t.calls.length).toBe(count + 1)
      expect(firstPr(t.registry.cachedSessionState('background')!)?.summary.number).toBe(7)
    } finally { t.registry.dispose() }
  })

  it('pauses every automatic read below 500, preserves cache and recovers after reset', async () => {
    const limit = { remaining: 499, resetAt: new Date(1_060_000).toISOString() }
    const t = setup({ rateLimit: limit })
    try {
      await t.registry.subscribe({ ...sub(), foreground: true })
      await t.flush()
      const count = t.calls.length
      await t.registry.nudge('s1', 'c1', true)
      await t.registry.getDetails('s1', 'github.com/acme/app#7', 'c1')
      await t.registry.fetchReviewSignature({ coords: REPO.repo!, number: 7, workspaceRootPath: '/ws' })
      expect(t.calls.length).toBe(count)
      expect(firstPr(t.registry.cachedSessionState('s1')!)?.summary.attentionStale).toBeUndefined()
      limit.remaining = 4000
      limit.resetAt = new Date(1_120_000).toISOString()
      await t.advance(60_000)
      expect(t.calls.length).toBe(count + 1)
    } finally { t.registry.dispose() }
  })

  it('does not let an older high-budget response reopen background polling', async () => {
    const limit = { remaining: 900, resetAt: new Date(1_360_000).toISOString() }
    const t = setup({ rateLimit: limit })
    try {
      await t.registry.subscribe(sub())
      await t.flush()
      limit.remaining = 4000
      await t.registry.nudge('s1') // A late response carries an older, larger counter.
      const count = t.calls.length
      await t.registry.nudge('s1', 'c1', true)
      expect(t.calls.length).toBe(count)
      expect(t.nextDelay()).toBe(360_000)
    } finally { t.registry.dispose() }
  })

  it('rechecks the shared budget before dispatching queued requests', async () => {
    let calls = 0
    const release: Array<(remaining: number) => void> = []
    const registry = new PrWatchRegistry({
      graphql: async <T,>() => {
        calls++
        const remaining = await new Promise<number>(resolve => release.push(resolve))
        return { rateLimit: { remaining, resetAt: new Date(Date.now() + 600_000).toISOString() }, repository: { pullRequests: { nodes: [PR] } } } as T
      },
      candidates: async () => [{ id: 'gh', label: 'gh', getToken: async () => 'token' }],
      push: () => {},
      resolveRepo: async dir => ({ ...REPO, root: dir }),
      localStatus: async () => ({ localAhead: 0, localDirty: false }),
      watchRefs: () => () => {}, setTimer: () => 0, clearTimer: () => {},
    })
    try {
      for (let i = 0; i < 30; i++) await registry.subscribe({ ...sub(`s${i}`), dir: `/repo/${i}` })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(calls).toBe(4)
      release[0]!(900)
      await new Promise(resolve => setTimeout(resolve, 0))
      for (const finish of release.slice(1)) finish(4000)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(calls).toBe(4)
    } finally { registry.dispose(); for (const finish of release) finish(900) }
  })
})
