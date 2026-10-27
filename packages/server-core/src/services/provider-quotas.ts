import type { CliProxyAccount } from '@craft-agent/shared/protocol'
import type { ProviderAccountQuota, ProviderQuotaWindow, ProviderQuotasRequest, ProviderQuotasSnapshot } from '../../../shared/src/protocol/provider-quotas'

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null
const percent = (value: unknown): number | null => { const n = number(value); return n !== null && n >= 0 && n <= 100 ? n : null }
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 100 && !/[\x00-\x1f]/.test(value) ? value : undefined
const instant = (value: unknown): number | null => {
  const n = number(value)
  if (n !== null) return n > 0 ? (n < 1e12 ? n * 1000 : n) : null
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

/** Keep real zeroes and nullable windows; never derive quota from dollars or billed tokens. */
export function normalizeClaudeQuota(payload: unknown): ProviderQuotaWindow[] {
  const body = record(payload)
  const windows = new Map<string, ProviderQuotaWindow>()
  for (const [key, label] of [['five_hour', '5 hours'], ['seven_day', 'Weekly'], ['seven_day_opus', 'Weekly · Opus'], ['seven_day_sonnet', 'Weekly · Sonnet'], ['seven_day_oauth_apps', 'Weekly · OAuth apps'], ['seven_day_cowork', 'Weekly · Cowork']] as const) {
    if (!body[key] || typeof body[key] !== 'object') continue
    const value = record(body[key])
    windows.set(key, { id: key, label, period: key === 'five_hour' ? 'five_hour' : 'weekly',
      scope: key !== 'five_hour' && key !== 'seven_day' ? label.split(' · ')[1] : undefined,
      usedPercent: percent(value.utilization), resetsAt: instant(value.resets_at), durationSeconds: key === 'five_hour' ? 18000 : 604800 })
  }
  if (Array.isArray(body.limits)) for (const item of body.limits.slice(0, 40)) {
    const value = record(item)
    const kind = value.kind
    if (!['session', 'weekly_all', 'weekly_scoped'].includes(String(kind))) continue
    const scope = kind === 'weekly_scoped' ? text(record(record(value.scope).model).display_name) : undefined
    // A scoped weekly quota cannot stand in for the account-wide weekly ring.
    const id = kind === 'session' ? 'five_hour' : kind === 'weekly_all' ? 'seven_day' : `weekly:${scope ?? 'model'}`
    windows.set(id, { id, label: kind === 'session' ? '5 hours' : scope ? `Weekly · ${scope}` : kind === 'weekly_scoped' ? 'Weekly · Model' : 'Weekly',
      period: kind === 'session' ? 'five_hour' : 'weekly', scope: kind === 'weekly_scoped' ? scope ?? 'Model' : undefined,
      usedPercent: percent(value.percent), resetsAt: instant(value.resets_at), durationSeconds: kind === 'session' ? 18000 : 604800 })
  }
  return [...windows.values()].sort((a, b) => Number(a.period !== 'five_hour') - Number(b.period !== 'five_hour') || Number(!!a.scope) - Number(!!b.scope) || a.label.localeCompare(b.label))
}

export function normalizeCodexQuota(payload: unknown, now: number): { windows: ProviderQuotaWindow[]; plan?: string; denied: boolean } {
  const body = record(payload)
  const windows: ProviderQuotaWindow[] = []
  const limits = [{ id: 'account', value: body.rate_limit ?? body.rateLimit, scope: undefined as string | undefined }]
  const additional = body.additional_rate_limits ?? body.additionalRateLimits
  if (Array.isArray(additional)) for (const [i, item] of additional.slice(0, 12).entries()) {
    const value = record(item)
    limits.push({ id: `additional:${i}`, value: value.rate_limit ?? value.rateLimit, scope: text(value.limit_name ?? value.limitName) ?? 'Model' })
  }
  if (body.code_review_rate_limit ?? body.codeReviewRateLimit) limits.push({ id: 'review', value: body.code_review_rate_limit ?? body.codeReviewRateLimit, scope: 'Code review' })
  for (const limit of limits) for (const key of ['primary', 'secondary'] as const) {
    const value = record(record(limit.value)[`${key}_window`] ?? record(limit.value)[`${key}Window`])
    if (!Object.keys(value).length) continue
    const duration = number(value.limit_window_seconds ?? value.limitWindowSeconds)
    const seconds = duration !== null && duration > 0 ? duration : null
    const period = seconds === 18000 ? 'five_hour' : seconds === 604800 ? 'weekly' : 'other'
    const after = number(value.reset_after_seconds ?? value.resetAfterSeconds)
    const resetsAt = instant(value.reset_at ?? value.resetAt) ?? (after !== null && after >= 0 ? now + after * 1000 : null)
    const label = period === 'five_hour' ? '5 hours' : period === 'weekly' ? 'Weekly' : seconds ? `${Math.round(seconds / 60)} minutes` : `${key === 'primary' ? 'Primary' : 'Secondary'} window`
    windows.push({ id: `${limit.id}:${key}`, label: limit.scope ? `${label} · ${limit.scope}` : label, period, scope: limit.scope,
      usedPercent: percent(value.used_percent ?? value.usedPercent), resetsAt, durationSeconds: seconds })
  }
  const account = record(body.rate_limit ?? body.rateLimit)
  return { windows, plan: text(body.plan_type ?? body.planType), denied: account.allowed === false || account.limit_reached === true || account.limitReached === true }
}

export interface QuotaRelayResponse { status_code: number; header?: Record<string, string[]>; body: string }
export interface QuotaSource {
  status(): Promise<{ running: boolean; accounts: CliProxyAccount[]; error?: string }>
  relayQuota(accountId: string): Promise<QuotaRelayResponse>
}
const STALE_MS = 5 * 60_000
const MIN_REFRESH_MS = 30_000
const MAX_BACKOFF_MS = 15 * 60_000

/** Demand-only cache: no timer, no auth refresh, no reset or scheduler mutation. */
export class ProviderQuotaService {
  private cache = new Map<string, ProviderAccountQuota>()
  private failures = new Map<string, number>()
  private pending = new Map<string, Promise<void>>()
  constructor(private source: QuotaSource, private now = Date.now) {}

  async get(request: ProviderQuotasRequest = {}): Promise<ProviderQuotasSnapshot> {
    const now = this.now()
    let status: Awaited<ReturnType<QuotaSource['status']>>
    try { status = await this.source.status() } catch { status = { running: false, accounts: [] } }
    if (!status.running || status.error) return { generatedAt: now, serviceAvailable: false, accounts: [...this.cache.values()].map(value => ({ ...value, state: 'unavailable', freshness: value.observedAt === null ? 'never' : 'stale', availability: value.disabled ? 'disabled' : 'unknown' })) }
    const ids = new Set(status.accounts.map(account => account.id))
    for (const id of this.cache.keys()) if (!ids.has(id)) { this.cache.delete(id); this.failures.delete(id) }
    for (const account of status.accounts) {
      const existing = this.cache.get(account.id)
      this.cache.set(account.id, { ...existing, accountId: account.id, name: account.name, provider: account.provider, disabled: account.disabled,
        state: existing?.state ?? 'unavailable', freshness: existing?.freshness ?? 'never', availability: account.disabled ? 'disabled' : existing?.disabled ? 'unknown' : existing?.availability ?? 'unknown',
        windows: existing?.windows ?? [], observedAt: existing?.observedAt ?? null, checkedAt: existing?.checkedAt ?? null, nextRefreshAt: existing?.nextRefreshAt ?? null })
    }
    if (request.refresh) await Promise.all(status.accounts.filter(account => !account.disabled && (!request.accountId || account.id === request.accountId)).map(account => this.refresh(account.id)))
    const generatedAt = this.now()
    return { generatedAt, serviceAvailable: true, accounts: status.accounts.map(account => this.display(this.cache.get(account.id)!, generatedAt)) }
  }

  private display(value: ProviderAccountQuota, now: number): ProviderAccountQuota {
    const resetPassed = value.windows.some(window => window.resetsAt !== null && window.resetsAt <= now && value.observedAt !== null && window.resetsAt > value.observedAt)
    const stale = value.observedAt !== null && (now - value.observedAt >= STALE_MS || resetPassed || value.state !== 'ready')
    return { ...value, freshness: value.observedAt === null ? 'never' : stale ? 'stale' : 'fresh', availability: value.disabled ? 'disabled' : stale ? 'unknown' : value.availability }
  }

  private refresh(id: string): Promise<void> {
    const pending = this.pending.get(id)
    if (pending) return pending
    const value = this.cache.get(id)!
    const now = this.now()
    if (value.nextRefreshAt !== null && now < value.nextRefreshAt) return Promise.resolve()
    const task = this.fetchQuota(id).finally(() => this.pending.delete(id))
    this.pending.set(id, task)
    return task
  }

  private async fetchQuota(id: string): Promise<void> {
    const previous = this.cache.get(id)!
    const now = this.now()
    let result: QuotaRelayResponse
    try { result = await this.source.relayQuota(id) } catch { result = { status_code: 0, body: '' } }
    const checkedAt = this.now()
    let body: unknown
    try { body = JSON.parse(result.body) } catch { body = null }
    const parsed = previous.provider === 'claude' ? { windows: normalizeClaudeQuota(body), plan: undefined, denied: false } : normalizeCodexQuota(body, checkedAt)
    if (result.status_code >= 200 && result.status_code < 300 && parsed.windows.length > 0) {
      this.failures.delete(id)
      this.cache.set(id, { ...previous, state: 'ready', freshness: 'fresh', windows: parsed.windows, plan: parsed.plan,
        availability: parsed.denied || parsed.windows.some(window => !window.scope && window.usedPercent === 100) ? 'exhausted'
          : parsed.windows.some(window => !window.scope && window.usedPercent !== null) ? 'available' : 'unknown',
        checkedAt, observedAt: checkedAt, nextRefreshAt: checkedAt + MIN_REFRESH_MS })
      return
    }
    const failures = (this.failures.get(id) ?? 0) + 1
    this.failures.set(id, failures)
    const retryHeader = Object.entries(result.header ?? {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1]?.[0]
    const retrySeconds = number(retryHeader)
    const retryAt = retrySeconds !== null && retrySeconds >= 0 ? checkedAt + retrySeconds * 1000 : instant(retryHeader)
    const backoff = Math.min(MAX_BACKOFF_MS, MIN_REFRESH_MS * 2 ** Math.min(failures - 1, 6))
    this.cache.set(id, { ...previous, state: result.status_code === 429 ? 'rate_limited' : [401, 403].includes(result.status_code) ? 'auth_required' : 'unavailable',
      freshness: previous.observedAt === null ? 'never' : 'stale', availability: 'unknown', checkedAt,
      nextRefreshAt: Math.max(now + backoff, retryAt ?? 0) })
  }
}
