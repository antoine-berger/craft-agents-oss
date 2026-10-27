import { describe, expect, it, mock } from 'bun:test'
import { normalizeClaudeQuota, normalizeCodexQuota, ProviderQuotaService, type QuotaRelayResponse } from './provider-quotas'

const NOW = Date.parse('2026-10-27T12:00:00Z')
const response = (body: unknown, status_code = 200, header: Record<string, string[]> = {}): QuotaRelayResponse => ({ status_code, header, body: JSON.stringify(body) })
const claude = (five: number, week: number) => ({ five_hour: { utilization: five, resets_at: null }, seven_day: { utilization: week, resets_at: '2026-11-01T11:00:00Z' } })
function harness() {
  let now = NOW
  const replies = new Map([['a', response(claude(0, 9))], ['b', response(claude(15, 17))]])
  const source = {
    status: mock(async () => ({ running: true, accounts: [
      { id: 'a', name: 'Claude A', provider: 'claude' as const, status: 'active', disabled: false },
      { id: 'b', name: 'Claude B', provider: 'claude' as const, status: 'active', disabled: false },
    ] })),
    relayQuota: mock(async (id: string) => replies.get(id)!),
  }
  return { source, replies, service: new ProviderQuotaService(source, () => now), advance: (ms: number) => { now += ms } }
}

describe('official quota normalization', () => {
  it('supports Claude legacy and structured responses, including inactive windows and scoped Fable', () => {
    const windows = normalizeClaudeQuota({ ...claude(0, 9), limits: [
      { kind: 'session', percent: 0, resets_at: null, is_active: false },
      { kind: 'weekly_all', percent: 11, resets_at: '2026-11-01T11:00:00Z', is_active: false },
      { kind: 'weekly_scoped', percent: 29, scope: { model: { display_name: 'Fable' } } },
    ], access_token: 'secret', spend: { amount_minor: 99999 } })
    expect(windows).toHaveLength(3)
    expect(windows[0]).toMatchObject({ period: 'five_hour', usedPercent: 0, resetsAt: null })
    expect(windows[1]).toMatchObject({ period: 'weekly', usedPercent: 11, scope: undefined })
    expect(windows[2]).toMatchObject({ scope: 'Fable', usedPercent: 29 })
    expect(JSON.stringify(windows)).not.toContain('secret')
    expect(normalizeClaudeQuota(claude(0, 9))[1]?.usedPercent).toBe(9)
  })
  it('keeps missing/null windows distinct from zero and ignores dollar percentages', () => {
    expect(normalizeClaudeQuota({ five_hour: null, seven_day: null, extra_usage: { utilization: 0 } })).toEqual([])
    expect(normalizeClaudeQuota({ five_hour: { utilization: null, used_dollars: 10, limit_dollars: 100 } })[0]?.usedPercent).toBeNull()
    expect(normalizeClaudeQuota({ five_hour: { utilization: -1 } })[0]?.usedPercent).toBeNull()
    expect(normalizeClaudeQuota({ five_hour: { utilization: 101 } })[0]?.usedPercent).toBeNull()
  })
  it('maps the live GPT prolite primary weekly window by duration, never by slot name', () => {
    const value = normalizeCodexQuota({ plan_type: 'prolite', rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 52, limit_window_seconds: 604800, reset_at: 1793640202 }, secondary_window: null } }, NOW)
    expect(value.plan).toBe('prolite')
    expect(value.windows).toHaveLength(1)
    expect(value.windows[0]).toMatchObject({ period: 'weekly', usedPercent: 52, resetsAt: 1793640202000 })
    expect(value.windows.find(window => window.period === 'five_hour')).toBeUndefined()
  })
  it('preserves nonstandard Codex windows and scoped limits without inventing a duration', () => {
    const value = normalizeCodexQuota({ rate_limit: { primary_window: { used_percent: 5, reset_after_seconds: 120 }, secondary_window: { used_percent: 18, limit_window_seconds: 18000 } }, additional_rate_limits: [{ limit_name: 'Spark', rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 604800 } } }] }, NOW)
    expect(value.windows[0]).toMatchObject({ period: 'other', resetsAt: NOW + 120000, durationSeconds: null })
    expect(value.windows[1]?.period).toBe('five_hour')
    expect(value.windows[2]).toMatchObject({ scope: 'Spark', period: 'weekly' })
  })
})

describe('read-only quota cache', () => {
  it('does not query providers for cached reads and keeps each account separate', async () => {
    const { service, source } = harness()
    const empty = await service.get()
    expect(empty.accounts[0]).toMatchObject({ freshness: 'never', availability: 'unknown', windows: [] })
    expect(source.relayQuota).not.toHaveBeenCalled()
    const actual = await service.get({ refresh: true })
    expect(actual.accounts.map(account => account.windows.find(window => window.period === 'weekly')?.usedPercent)).toEqual([9, 17])
    await service.get()
    await service.get({ refresh: true })
    expect(source.relayQuota).toHaveBeenCalledTimes(2)
    expect(actual.accounts[0]?.availability).toBe('available')
  })
  it('refreshes a selected account without polling or changing the pool', async () => {
    const { service, source } = harness()
    const result = await service.get({ refresh: true, accountId: 'b' })
    expect(source.relayQuota.mock.calls).toEqual([['b']])
    expect(result.accounts[0]?.observedAt).toBeNull()
    expect(result.accounts[1]?.windows[0]?.usedPercent).toBe(15)
  })
  it('preserves a stale observation on 429 and respects Retry-After instead of showing 0%', async () => {
    const { service, replies, source, advance } = harness()
    await service.get({ refresh: true, accountId: 'b' })
    advance(31_000)
    replies.set('b', response({ access_token: 'not-exposed' }, 429, { 'Retry-After': ['120'] }))
    const result = await service.get({ refresh: true, accountId: 'b' })
    expect(result.accounts[1]).toMatchObject({ state: 'rate_limited', freshness: 'stale', availability: 'unknown', nextRefreshAt: NOW + 151000 })
    expect(result.accounts[1]?.windows[0]?.usedPercent).toBe(15)
    expect(JSON.stringify(result)).not.toContain('not-exposed')
    advance(60_000)
    await service.get({ refresh: true, accountId: 'b' })
    expect(source.relayQuota).toHaveBeenCalledTimes(2)
  })
  it('distinguishes auth failure, malformed data, exhaustion and missing windows', async () => {
    const { service, replies, advance } = harness()
    replies.set('a', response({}, 401))
    replies.set('b', response(claude(100, 17)))
    let result = await service.get({ refresh: true })
    expect(result.accounts[0]).toMatchObject({ state: 'auth_required', freshness: 'never', availability: 'unknown' })
    expect(result.accounts[1]).toMatchObject({ state: 'ready', availability: 'exhausted' })
    advance(31_000)
    replies.set('a', response({ five_hour: null, seven_day: null }))
    result = await service.get({ refresh: true, accountId: 'a' })
    expect(result.accounts[0]).toMatchObject({ state: 'unavailable', availability: 'unknown', windows: [] })
  })
  it('ages observations and never turns a reset into a fabricated fresh zero', async () => {
    const { service, replies, advance } = harness()
    replies.set('a', response({ five_hour: { utilization: 100, resets_at: new Date(NOW + 60_000).toISOString() } }))
    await service.get({ refresh: true, accountId: 'a' })
    advance(60_001)
    const result = await service.get()
    expect(result.accounts[0]).toMatchObject({ freshness: 'stale', availability: 'unknown' })
    expect(result.accounts[0]?.windows[0]?.usedPercent).toBe(100)
  })
  it('backs off failures and preserves cached data when the account service is offline', async () => {
    const { service, source, replies, advance } = harness()
    await service.get({ refresh: true, accountId: 'a' })
    advance(31_000)
    replies.set('a', { status_code: 502, body: 'not-json' })
    await service.get({ refresh: true, accountId: 'a' })
    advance(31_000)
    const secondFailure = await service.get({ refresh: true, accountId: 'a' })
    expect(secondFailure.accounts[0]?.nextRefreshAt).toBe(NOW + 122_000)
    source.status = mock(async () => ({ running: false, accounts: [] }))
    const offline = await service.get()
    expect(offline.serviceAvailable).toBe(false)
    expect(offline.accounts[0]).toMatchObject({ state: 'unavailable', freshness: 'stale', availability: 'unknown' })
    expect(offline.accounts[0]?.windows[1]?.usedPercent).toBe(9)
  })
  it('coalesces concurrent refreshes per account and skips disabled accounts', async () => {
    const { service, source } = harness()
    let finish!: (value: QuotaRelayResponse) => void
    source.status = mock(async () => ({ running: true, accounts: [
      { id: 'a', name: 'A', provider: 'claude' as const, status: 'active', disabled: false },
      { id: 'b', name: 'B', provider: 'claude' as const, status: 'disabled', disabled: true },
    ] }))
    source.relayQuota = mock(async (_id: string) => await new Promise<QuotaRelayResponse>(resolve => { finish = resolve }))
    const first = service.get({ refresh: true })
    const second = service.get({ refresh: true })
    await Promise.resolve()
    await Promise.resolve()
    finish(response(claude(0, 0)))
    const results = await Promise.all([first, second])
    expect(source.relayQuota).toHaveBeenCalledTimes(1)
    expect(results[0]?.accounts[1]?.availability).toBe('disabled')
  })
})
