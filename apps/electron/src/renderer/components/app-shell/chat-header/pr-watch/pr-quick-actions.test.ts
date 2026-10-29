import { expect, test } from 'bun:test'
import { savedPrSummary } from '../../../../../../../../packages/server-core/src/services/pr-watch/association-store'
import { nextPrQuickAction, prQuickActionMessage, type PrQuickAction } from './pr-quick-actions'
import type { PrWatchState } from '@craft-agent/shared/protocol'

const live: Extract<PrWatchState, { kind: 'pr' }> = { kind: 'pr', summary: {
  number: 7, title: 'Feature', url: 'https://github.com/acme/app/pull/7', state: 'open',
  headRef: 'me/topic', baseRef: 'release/next', headMatchesLocal: true, headOid: 'abc',
  localAhead: 0, localDirty: false, checks: 'success', reviewDecision: 'approved', mergeState: 'clean',
  unresolvedThreads: 0, fetchedAt: 1, via: 'gh',
} }

test('a saved association is a read-only link, never an action based on old CI/reviews', () => {
  const summary = savedPrSummary({ coords: { host: 'github.com', owner: 'acme', repo: 'app' }, number: 7,
    title: 'Feature', url: 'https://github.com/acme/app/pull/7', headRef: 'feat/x', baseRef: 'main',
    headOid: 'abc', state: 'open', fetchedAt: 1, via: 'gh' })
  for (const state of ['open', 'draft', 'merged', 'closed'] as const) {
    expect(nextPrQuickAction({ kind: 'pr', summary: { ...summary, state } }, 'branch')).toBeNull()
  }
})

test('button prompts are concise and keep the selected PR and branch explicit', () => {
  for (const action of ['commit-push', 'push', 'pull', 'rebase', 'resolve', 'fix', 'fix-ci'] as const) {
    const message = prQuickActionMessage(action, live, 'branch')!
    expect(message).toContain(live.summary.url)
    expect(message).toContain(live.summary.headRef)
    expect(message.length).toBeLessThan(700)
    expect(message).not.toMatch(/\n\d\./)
  }
  const create = prQuickActionMessage('create', { kind: 'none' })!
  expect(create).toStartWith('Create a PR')
  expect(create).toContain('parent branch')
  expect(create).toContain('do not create an empty PR')
})

test('rebase retains stack, checks, lease and changed-remote safeguards', () => {
  const message = prQuickActionMessage('rebase', live, 'branch')!
  expect(message).toStartWith('Rebase this branch onto the remote-tracking base ("release/next").')
  expect(message).toContain('Fetch it first')
  expect(message).toContain('preserve the parent branch for stacks')
  expect(message).toContain('run the relevant checks')
  expect(message).toContain('--force-with-lease pinned to the fetched remote head; stop if it changes')
  expect(message).toContain('Do not merge')
})

test('CI references actual failing checks without inventing attached logs', () => {
  const message = prQuickActionMessage('fix-ci', { ...live, details: {
    additions: 0, deletions: 0, changedFiles: 0, reviewers: [],
    lastCommit: { sha: 'abc', headline: 'Feature', author: 'me', committedAt: 1 },
    checks: [{ name: 'test', status: 'failure', url: 'https://ci.example/job/7' }, { name: 'lint', status: 'success' }],
  } }, 'branch')!
  expect(message).toStartWith('Fix the failing CI actions.')
  expect(message).toContain('Read the failure logs')
  expect(message).toContain('- test (https://ci.example/job/7)')
  expect(message).not.toContain('- lint')
  expect(message).not.toContain("I've attached")
  expect(message).toContain('If flaky or unrelated, explain instead of changing code')
  expect(message).toContain("Don't push unless I ask")
})

test('review and conflict shortcuts preserve their existing limits', () => {
  const review = prQuickActionMessage('fix', live, 'branch')!
  expect(review).toContain('unresolved inline threads')
  expect(review).toContain('explain any disagreement')
  expect(review).toContain("Don't push, reply on GitHub or resolve threads unless I ask")
  const resolve = prQuickActionMessage('resolve', live, 'branch')!
  expect(resolve).toContain('Fetch the base remote and merge its remote-tracking ref ("release/next")')
  expect(resolve).toContain('ask if a decision is needed')
  expect(resolve).toContain("Don't rebase. Don't push unless I ask")
})

test('pinned PR shortcuts cannot switch or change the current checkout', () => {
  for (const action of ['commit-push', 'push', 'pull', 'rebase', 'resolve', 'fix', 'fix-ci'] as const) {
    const message = prQuickActionMessage(action, live, 'bound')!
    expect(message).toContain('Reuse its existing worktree or create a separate checkout')
    expect(message).toContain("Don't switch this folder's branch or change its files")
    expect(message).toContain('Work there and report its path')
    expect(message).toContain(live.summary.url)
  }
})

test('native GitHub actions do not become agent prompts', () => {
  for (const action of ['ready', 'rerun', 'auto-merge', 'disable-auto-merge', 'merge', 'queued', 'archive'] satisfies PrQuickAction[]) {
    expect(prQuickActionMessage(action, live)).toBeNull()
  }
  expect(prQuickActionMessage('rebase', { kind: 'loading' })).toBeNull()
})
