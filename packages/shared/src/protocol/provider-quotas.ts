/** Read-only provider observations. No credential, auth index or upstream body crosses RPC. */
export const PROVIDER_QUOTA_CHANNELS = { GET: 'providerQuotas:get' } as const

export interface ProviderQuotaWindow {
  id: string
  label: string
  /** Only explicit upstream window metadata determines the ring. */
  period: 'five_hour' | 'weekly' | 'other'
  scope?: string
  usedPercent: number | null
  resetsAt: number | null
  durationSeconds: number | null
}

export interface ProviderAccountQuota {
  accountId: string
  name: string
  provider: 'claude' | 'codex'
  disabled: boolean
  state: 'ready' | 'unavailable' | 'auth_required' | 'rate_limited'
  freshness: 'fresh' | 'stale' | 'never'
  availability: 'available' | 'exhausted' | 'unknown' | 'disabled'
  windows: ProviderQuotaWindow[]
  plan?: string
  observedAt: number | null
  checkedAt: number | null
  /** Server-enforced request cooldown, independent of provider quota reset. */
  nextRefreshAt: number | null
}

export interface ProviderQuotasSnapshot {
  accounts: ProviderAccountQuota[]
  generatedAt: number
  serviceAvailable: boolean
}

export interface ProviderQuotasRequest {
  /** False reads the cache only; refresh reads the selected account with server-enforced cooldown/backoff. */
  refresh?: boolean
  accountId?: string
}
