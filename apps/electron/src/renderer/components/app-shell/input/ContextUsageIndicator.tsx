import type { ContextUsageSnapshot } from '@craft-agent/core/types'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { contextIndicatorValues } from './context-usage-indicator-model'

export interface ContextUsageIndicatorProps {
  snapshot?: ContextUsageSnapshot
  modelName?: string
  modelContextWindow?: number | null
  updatedAt?: number | null
  /** Only current-context cache occupancy belongs here, never lifetime billing totals. */
  currentCacheTokens?: number | null
  isProcessing?: boolean
  onCompact?: () => void
  className?: string
}

const tokenLabel = (value: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

export function ContextUsageIndicator({ snapshot, modelName, modelContextWindow, updatedAt, currentCacheTokens, isProcessing, onCompact, className }: ContextUsageIndicatorProps) {
  const value = contextIndicatorValues(snapshot, modelContextWindow)
  const cache = count(currentCacheTokens)
  const known = value.percent !== null && !value.stale
  const circle = 2 * Math.PI * 5.5
  return <Popover>
    <PopoverTrigger asChild>
      <button type="button" className={cn('input-toolbar-btn inline-flex h-control shrink-0 items-center gap-1.5 rounded-full px-2 text-xs tabular-nums text-tertiary hover:bg-foreground/5 hover:text-foreground', known && value.percent! >= 90 && 'text-info', className)} aria-label={`Context usage ${known ? `${value.percent}%` : 'unknown'}`}>
        <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" opacity="0.2" strokeDasharray={known ? undefined : '2 3'} />{known && <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeDasharray={`${circle * Math.min(100, value.percent!) / 100} ${circle}`} />}</svg>
        <span>{known ? `${value.percent}%` : '—'}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent side="top" align="end" sideOffset={8} className="w-[280px] p-3.5 text-xs">
      <div className="font-medium text-sm text-foreground">Context</div>
      {modelName && <div className="mt-0.5 text-tertiary">{modelName}</div>}
      <div className="mt-3 space-y-2">
        <div className="flex justify-between gap-4"><span className="text-secondary">Current usage</span><span className="tabular-nums">{value.used === null ? 'Not available' : `${tokenLabel(value.used)} tokens`}{value.estimate && value.used !== null ? ' · estimated' : ''}</span></div>
        <div className="flex justify-between gap-4"><span className="text-secondary">{snapshot?.limitKind === 'compaction' ? 'Compaction threshold' : 'Context window'}</span><span className="tabular-nums">{value.limit === null ? 'Not available' : `${tokenLabel(value.limit)} tokens`}</span></div>
        {value.modelWindow !== null && value.modelWindow !== value.limit && <div className="flex justify-between gap-4"><span className="text-secondary">Model capacity</span><span className="tabular-nums">{tokenLabel(value.modelWindow)} tokens</span></div>}
        {value.percent !== null && <div className="flex justify-between gap-4"><span className="text-secondary">Used</span><span className="tabular-nums">{value.percent}%{value.stale ? ' · out of date' : ''}</span></div>}
        {cache !== null && <div className="flex justify-between gap-4"><span className="text-secondary">Cached in current context</span><span className="tabular-nums">{tokenLabel(cache)} tokens</span></div>}
      </div>
      <div className="mt-3 text-[11px] leading-relaxed text-tertiary">{value.stale ? 'Context changed; waiting for a fresh measurement.' : value.used === null ? 'Available after the agent reports a context measurement.' : 'Current context occupancy. This is separate from cumulative billed tokens.'}{updatedAt ? ` Updated ${new Date(updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''}</div>
      {snapshot?.canCompact && onCompact && <button type="button" disabled={isProcessing} onClick={onCompact} className="mt-3 w-full rounded-md bg-foreground/5 py-1.5 text-secondary hover:bg-foreground/10 disabled:opacity-40">{isProcessing ? 'Wait for the agent to finish' : 'Compact context'}</button>}
    </PopoverContent>
  </Popover>
}
