import type { ProviderAccountQuota, ProviderQuotasSnapshot } from '@craft-agent/shared/protocol'

export const QUOTA_REFRESH_MS = 60_000
export const quotaExpiresAt = (account: ProviderAccountQuota) => Math.min(account.observedAt === null ? Infinity : account.observedAt + 300_000,
  ...account.windows.map(window => window.resetsAt !== null && account.observedAt !== null && window.resetsAt > account.observedAt ? window.resetsAt : Infinity))
export const quotaStorageKey = (scope: string) => `craft.quota-display:${scope}`

/** Never include credentials or URL query parameters in the cache namespace. */
export function quotaCacheScope(serverUrl: string | undefined, workspaceId: string | undefined): string {
  if (!serverUrl) return `local:${workspaceId ?? 'default'}`
  try { const url = new URL(serverUrl); return `${url.protocol}//${url.host}${url.pathname}:${workspaceId ?? 'default'}` }
  catch { return `remote:${workspaceId ?? 'default'}` }
}

const timestamp = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value))

export function readQuotaDisplay(scope: string): { snapshot?: ProviderQuotasSnapshot; selectedId: string | null } {
  try {
    const value = JSON.parse(localStorage.getItem(quotaStorageKey(scope)) ?? 'null')
    const selectedId = typeof value?.selectedId === 'string' ? value.selectedId : localStorage.getItem('craft.quota-display-account')
    const snapshot = value?.snapshot as ProviderQuotasSnapshot | undefined
    if (!snapshot || !Array.isArray(snapshot.accounts) || snapshot.accounts.length > 100 || !Number.isFinite(snapshot.generatedAt)
      || typeof snapshot.serviceAvailable !== 'boolean' || !snapshot.accounts.every(account => typeof account.accountId === 'string'
        && typeof account.name === 'string' && typeof account.disabled === 'boolean'
        && ['ready', 'unavailable', 'auth_required', 'rate_limited'].includes(account.state)
        && ['fresh', 'stale', 'never'].includes(account.freshness)
        && timestamp(account.observedAt) && timestamp(account.checkedAt) && timestamp(account.nextRefreshAt)
        && ['claude', 'codex'].includes(account.provider) && Array.isArray(account.windows) && account.windows.length <= 50
        && account.windows.every(window => typeof window.id === 'string' && typeof window.label === 'string' && timestamp(window.resetsAt) && ['five_hour', 'weekly', 'other'].includes(window.period)
          && (window.usedPercent === null || (Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100))))) {
      return { selectedId }
    }
    return { snapshot, selectedId }
  } catch { return { selectedId: null } }
}

export function saveQuotaDisplay(scope: string, snapshot: ProviderQuotasSnapshot, selectedId: string | null): void {
  try {
    const stored = readQuotaDisplay(scope).snapshot
    const value = stored && stored.generatedAt > snapshot.generatedAt ? mergeQuotaSnapshot(snapshot, stored) : mergeQuotaSnapshot(stored, snapshot)
    localStorage.setItem(quotaStorageKey(scope), JSON.stringify({ snapshot: value, selectedId }))
  } catch { /* Storage may be disabled. */ }
}

/** Inventory comes from the server; observations merge only within the same provider/account. */
export function mergeQuotaSnapshot(previous: ProviderQuotasSnapshot | undefined, incoming: ProviderQuotasSnapshot): ProviderQuotasSnapshot {
  const inventory = !incoming.serviceAvailable && incoming.accounts.length === 0 ? previous?.accounts ?? [] : incoming.accounts
  return { ...incoming, accounts: inventory.map(account => {
    const old = previous?.accounts.find(value => value.accountId === account.accountId && value.provider === account.provider)
    const latest = old && (old.observedAt ?? -1) > (account.observedAt ?? -1) ? old : account
    const source = latest.windows.length ? latest : old?.windows.length ? old : latest
    return { ...account, windows: source.windows, observedAt: source.observedAt, plan: source.plan,
      ...(!incoming.serviceAvailable || latest !== account || source !== account ? { freshness: source.observedAt === null ? 'never' as const : 'stale' as const, availability: 'unknown' as const } : {}) }
  }) }
}

export function quotaRefreshDue(account: ProviderAccountQuota | undefined, now: number): boolean {
  return !!account && !account.disabled && now >= Math.max(account.nextRefreshAt ?? 0, (account.checkedAt ?? 0) + QUOTA_REFRESH_MS)
}
