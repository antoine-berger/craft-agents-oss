import type { SessionSearchResponse, SessionSearchResult } from '@craft-agent/shared/protocol'

/** Older servers ignore the status opt-in and still return the original array. */
export function normalizeSessionSearchResponse(value: SessionSearchResponse | SessionSearchResult[], searchId: string): SessionSearchResponse {
  if (Array.isArray(value)) return { searchId, status: 'complete', results: value }
  if (value.searchId !== searchId || !Array.isArray(value.results)) throw new Error('Search response is no longer current.')
  return value
}

export function isIncompleteSearch(status: SessionSearchResponse['status']): boolean {
  return status === 'partial' || status === 'timed_out' || status === 'cancelled'
}
