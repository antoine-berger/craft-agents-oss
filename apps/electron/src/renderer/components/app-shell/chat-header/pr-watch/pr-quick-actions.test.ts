import { expect, test } from 'bun:test'
import { savedPrSummary } from '../../../../../../../../packages/server-core/src/services/pr-watch/association-store'
import { nextPrQuickAction } from './pr-quick-actions'

test('a saved association is a read-only link, never an action based on old CI/reviews', () => {
  const summary = savedPrSummary({ coords: { host: 'github.com', owner: 'acme', repo: 'app' }, number: 7,
    title: 'Feature', url: 'https://github.com/acme/app/pull/7', headRef: 'feat/x', baseRef: 'main',
    headOid: 'abc', state: 'open', fetchedAt: 1, via: 'gh' })
  for (const state of ['open', 'draft', 'merged', 'closed'] as const) {
    expect(nextPrQuickAction({ kind: 'pr', summary: { ...summary, state } }, 'branch')).toBeNull()
  }
})
