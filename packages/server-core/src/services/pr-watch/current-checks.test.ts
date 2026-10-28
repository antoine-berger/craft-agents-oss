import { describe, expect, test } from 'bun:test'
import { currentCheckContexts, mapChecksRollup } from './map-github'
import type { GqlCheckContext } from './github-queries'

type Run = Extract<GqlCheckContext, { __typename: 'CheckRun' }>
const run = (sequence: number, conclusion: string | null, workflow = 'review', app = 'actions'): Run => ({
  __typename: 'CheckRun', name: 'Review Gate', status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion,
  detailsUrl: null, databaseId: String(sequence), checkSuite: { app: { id: app }, workflowRun: { workflow: { id: workflow } } },
})
const rollup = (nodes: GqlCheckContext[], hasNextPage = false) => mapChecksRollup({ state: 'FAILURE', contexts: { pageInfo: { hasNextPage }, nodes } })

describe('current check attempts', () => {
  test('an older cancellation superseded by success does not request Fix CI', () => {
    const cancelled = run(100, 'CANCELLED'), success = run(101, 'SUCCESS')
    expect(currentCheckContexts([cancelled, success])).toEqual([success])
    expect(currentCheckContexts([success, cancelled])).toEqual([success])
    expect(rollup([cancelled, success])).toBe('success')
  })
  test('a newer failure, cancellation or pending rerun replaces the older success', () => {
    expect(rollup([run(100, 'SUCCESS'), run(101, 'FAILURE')])).toBe('failure')
    expect(rollup([run(100, 'SUCCESS'), run(101, 'CANCELLED')])).toBe('failure')
    expect(rollup([run(100, 'FAILURE'), run(101, null)])).toBe('pending')
  })
  test('same job name in another workflow or app cannot erase a failure', () => {
    expect(rollup([run(100, 'FAILURE', 'lint'), run(101, 'SUCCESS', 'review')])).toBe('failure')
    expect(rollup([run(100, 'FAILURE', 'review', 'other'), run(101, 'SUCCESS')])).toBe('failure')
  })
  test('unrelated failed jobs and legacy commit status failures stay visible', () => {
    expect(rollup([{ ...run(100, 'FAILURE'), name: 'Build' }, run(101, 'SUCCESS')])).toBe('failure')
    expect(rollup([run(101, 'SUCCESS'), { __typename: 'StatusContext', context: 'deployment', state: 'FAILURE', targetUrl: null }])).toBe('failure')
  })
  test('missing identity or attempt metadata cannot prove an old failure was superseded', () => {
    expect(rollup([{ ...run(100, 'FAILURE'), databaseId: undefined }, run(101, 'SUCCESS')])).toBe('failure')
    expect(rollup([{ ...run(100, 'FAILURE'), checkSuite: undefined }, run(101, 'SUCCESS')])).toBe('failure')
  })
  test('a truncated list cannot turn the authoritative failure green', () => {
    expect(rollup([run(100, 'CANCELLED'), run(101, 'SUCCESS')], true)).toBe('failure')
    expect(mapChecksRollup({ state: 'FAILURE' })).toBe('failure')
  })
})
