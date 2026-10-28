import { expect, test } from 'bun:test'
import { isIncompleteSearch, normalizeSessionSearchResponse } from './session-search-response'

test('accepts an old server array while retaining the new request identity', () => {
  expect(normalizeSessionSearchResponse([], 'query-1')).toEqual({ searchId: 'query-1', results: [], status: 'complete' })
})
test('never applies a response belonging to another query', () => {
  expect(() => normalizeSessionSearchResponse({ searchId: 'old', status: 'complete', results: [] }, 'current')).toThrow('no longer current')
})
test('marks interruptions as incomplete, not successful empty searches', () => {
  for (const status of ['partial', 'timed_out', 'cancelled'] as const) expect(isIncompleteSearch(status)).toBe(true)
  for (const status of ['complete', 'unavailable'] as const) expect(isIncompleteSearch(status)).toBe(false)
})
