import { useEffect, useRef, useState } from 'react'
import { Check, RefreshCw } from 'lucide-react'
import type { ProviderAccountQuota, ProviderQuotaWindow, ProviderQuotasRequest, ProviderQuotasSnapshot } from '@craft-agent/shared/protocol'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface SidebarQuotaIndicatorProps {
  getQuotas: (request?: ProviderQuotasRequest) => Promise<ProviderQuotasSnapshot>
  className?: string
}

const SELECTION_KEY = 'craft.quota-display-account'
const selectedWindow = (account: ProviderAccountQuota | undefined, period: ProviderQuotaWindow['period']) => account?.windows.find(window => window.period === period && !window.scope)
const formatPercent = (value: number | null | undefined) => typeof value === 'number' ? `${Math.round(value)}%` : '—'
const dateLabel = (value: number | null) => value === null ? 'Not provided' : new Date(value).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
const expiresAt = (account: ProviderAccountQuota) => Math.min(account.observedAt === null ? Infinity : account.observedAt + 300_000,
  ...account.windows.map(window => window.resetsAt !== null && account.observedAt !== null && window.resetsAt > account.observedAt ? window.resetsAt : Infinity))

/** A neutral meter for one explicitly monitored account. It never changes account routing. */
export function QuotaRings({ account, className }: { account?: ProviderAccountQuota; className?: string }) {
  return <svg viewBox="0 0 28 28" className={cn('size-6 shrink-0 -rotate-90', className)} aria-hidden="true">
    {([['five_hour', 11], ['weekly', 7]] as const).map(([period, radius]) => {
      const window = selectedWindow(account, period)
      const known = account?.freshness === 'fresh' && window?.usedPercent !== null && window?.usedPercent !== undefined
      const length = Math.PI * 2 * radius
      return <g key={period}>
        <circle cx="14" cy="14" r={radius} fill="none" stroke="currentColor" strokeWidth="2" opacity={0.2} strokeDasharray={known ? undefined : '2 3'} />
        {known && <circle cx="14" cy="14" r={radius} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${length * window.usedPercent! / 100} ${length}`} />}
      </g>
    })}
  </svg>
}

function availabilityLabel(account: ProviderAccountQuota): string {
  if (account.disabled) return 'Disabled'
  if (account.state === 'rate_limited') return 'Refresh rate limited (429)'
  if (account.state === 'auth_required') return 'Account access unavailable'
  if (account.state === 'unavailable') return account.checkedAt === null ? 'Not checked' : 'Unavailable'
  if (account.freshness === 'stale') return 'Out of date'
  return account.availability === 'exhausted' ? 'Limit reached' : account.availability === 'available' ? 'Available' : 'Availability unknown'
}

export function SidebarQuotaIndicator({ getQuotas, className }: SidebarQuotaIndicatorProps) {
  const [snapshot, setSnapshot] = useState<ProviderQuotasSnapshot>()
  const [selectedId, setSelectedId] = useState<string | null>(() => { try { return localStorage.getItem(SELECTION_KEY) } catch { return null } })
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [, invalidateClock] = useState(0)
  const requestRef = useRef(getQuotas)
  requestRef.current = getQuotas
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    void requestRef.current({ refresh: false }).then(value => { if (mounted.current) setSnapshot(value) }).catch(() => { if (mounted.current) setFailed(true) })
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    const next = Math.min(...(snapshot?.accounts ?? []).map(expiresAt).filter(time => time > Date.now()))
    if (!Number.isFinite(next)) return
    // One local expiry timer updates presentation only. It never requests provider data.
    const timeout = setTimeout(() => invalidateClock(value => value + 1), Math.min(next - Date.now() + 10, 2_147_483_647))
    return () => clearTimeout(timeout)
  }, [snapshot])
  const accounts = (snapshot?.accounts ?? []).filter(account => !account.disabled).map(account => account.freshness === 'fresh' && expiresAt(account) <= Date.now()
    ? { ...account, freshness: 'stale' as const, availability: 'unknown' as const } : account)
  const selected = accounts.find(account => account.accountId === selectedId) ?? accounts.find(account => !account.disabled) ?? accounts[0]
  const fiveHour = selectedWindow(selected, 'five_hour')
  const weekly = selectedWindow(selected, 'weekly')
  const monitoredName = selected ? `${selected.provider === 'claude' ? 'Claude' : 'GPT'} · ${selected.name}` : 'Account quotas'
  const fresh = selected?.freshness === 'fresh'
  const refresh = async () => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    try { const value = await requestRef.current({ refresh: true }); if (mounted.current) setSnapshot(value) }
    catch { if (mounted.current) setFailed(true) }
    finally { if (mounted.current) setBusy(false) }
  }
  return <div className={className}><Popover onOpenChange={open => {
    if (open) void requestRef.current({ refresh: false }).then(value => { if (mounted.current) setSnapshot(value) }).catch(() => { if (mounted.current) setFailed(true) })
  }}>
    <PopoverTrigger asChild>
      <button type="button" className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-tertiary hover:bg-foreground/5 hover:text-foreground transition-colors"
        aria-label={`Account quotas · ${monitoredName}`} title={`${monitoredName} · 5h ${fresh ? formatPercent(fiveHour?.usedPercent) : '—'} · Weekly ${fresh ? formatPercent(weekly?.usedPercent) : '—'}`}>
        <QuotaRings account={selected} />
        <span className="min-w-0 flex-1 truncate text-left text-sm">Usage</span>
        <span className="text-xs tabular-nums">{fresh ? formatPercent(fiveHour?.usedPercent) : '—'}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent side="right" align="end" sideOffset={10} className="w-[320px] p-0 text-sm">
      <div className="flex items-center justify-between px-4 py-3 border-b border-foreground/5">
        <div className="font-medium text-foreground">Usage</div>
        <button type="button" onClick={() => void refresh()} disabled={busy} className="rounded-md p-1.5 text-tertiary hover:bg-foreground/5 hover:text-foreground disabled:opacity-40" aria-label="Refresh account quotas" title="Refresh quotas">
          <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
        </button>
      </div>
      <div className="max-h-[420px] overflow-y-auto divide-y divide-foreground/5">
        {accounts.map(account => <div key={account.accountId} className="px-4 py-3">
          <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => {
            setSelectedId(account.accountId)
            try { localStorage.setItem(SELECTION_KEY, account.accountId) } catch { /* Private browser storage may be disabled. */ }
          }} aria-label={`Monitor ${account.name}`} aria-pressed={selected?.accountId === account.accountId}>
            <QuotaRings account={account} className="size-5" />
            <span className="min-w-0 flex-1 truncate text-foreground font-medium" title={`${account.name} · ${account.provider === 'claude' ? 'Claude' : 'GPT'}${account.plan ? ` · ${account.plan}` : ''}`}>{account.name}</span>
            {selected?.accountId === account.accountId && <Check className="size-3.5 text-tertiary" />}
          </button>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
            {(['five_hour', 'weekly'] as const).map(period => {
              const window = selectedWindow(account, period)
              if (!window || window.usedPercent === null) return null
              const label = period === 'five_hour' ? '5h' : 'Weekly'
              return <div key={period} title={`${label}: ${formatPercent(window.usedPercent)} used${window.resetsAt === null ? '' : ` · Resets ${dateLabel(window.resetsAt)}`}`}>
                <div className="flex items-center justify-between text-xs"><span className="text-tertiary">{label}</span><span className={cn('tabular-nums text-secondary', window.usedPercent >= 100 && 'text-amber-500')}>{formatPercent(window.usedPercent)}</span></div>
                <div role="meter" aria-label={`${label} usage for ${account.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.usedPercent} aria-valuetext={`${formatPercent(window.usedPercent)} used${window.resetsAt === null ? '' : ` · Resets ${dateLabel(window.resetsAt)}`}`} className="mt-1.5 h-1 rounded-full bg-foreground/5 overflow-hidden"><div className={cn('h-full rounded-full', window.usedPercent >= 100 ? 'bg-amber-500/70' : 'bg-foreground/40', account.freshness !== 'fresh' && 'opacity-40')} style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }} /></div>
              </div>
            })}
          </div>
          {availabilityLabel(account) !== 'Available' && <div className={cn('mt-2 text-[11px]', account.availability === 'exhausted' && account.freshness === 'fresh' ? 'text-amber-500' : 'text-tertiary')}>{availabilityLabel(account)}</div>}
          <details className="mt-2 text-[11px] text-tertiary">
            <summary className="w-fit cursor-pointer select-none hover:text-foreground">Details</summary>
            <div className="mt-2 space-y-1.5">
              <div>{account.provider === 'claude' ? 'Claude' : 'GPT'}{account.plan ? ` · ${account.plan}` : ''}{account.observedAt ? ` · Updated ${new Date(account.observedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ' · Refresh to check'}</div>
              {account.windows.filter(window => window.usedPercent !== null).map(window => <div key={window.id} className="flex justify-between gap-3"><span>{window.label}{window.scope || window.period === 'other' ? ` · ${formatPercent(window.usedPercent)}` : ''}</span><span className="text-right">{window.resetsAt === null ? 'Reset time unavailable' : `Resets ${dateLabel(window.resetsAt)}`}</span></div>)}
              {account.nextRefreshAt !== null && account.nextRefreshAt > snapshot!.generatedAt && account.state !== 'ready' && <div>Retry after {new Date(account.nextRefreshAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</div>}
            </div>
          </details>
        </div>)}
        {!accounts.length && <div className="px-4 py-5 text-xs text-tertiary">{failed ? 'Unable to read account usage.' : snapshot?.serviceAvailable === false ? 'Account service unavailable.' : 'No connected account available.'}</div>}
      </div>
      {failed && accounts.length > 0 && <div role="alert" className="border-t border-foreground/5 px-4 py-2.5 text-[11px] text-tertiary">Refresh unavailable.</div>}
    </PopoverContent>
  </Popover></div>
}
