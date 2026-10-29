import type { ContextUsageSnapshot } from '@craft-agent/core/types'
import { useEffect, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { contextIndicatorValues, type ContextIndicatorSettings } from './context-usage-indicator-model'

export interface ContextUsageIndicatorProps {
  appearance?: 'default' | 'chat'
  snapshot?: ContextUsageSnapshot
  modelName?: string
  modelContextWindow?: number | null
  /** Window reported by this session's backend, distinct from static model capacity. */
  reportedContextWindow?: number | null
  useClaudeSettings?: boolean
  updatedAt?: number | null
  /** Only current-context cache occupancy belongs here, never lifetime billing totals. */
  currentCacheTokens?: number | null
  isProcessing?: boolean
  onCompact?: () => void
  className?: string
}

const tokenLabel = (value: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

export function ContextUsageIndicator({ appearance = 'default', snapshot, modelName, modelContextWindow, reportedContextWindow, useClaudeSettings, updatedAt, currentCacheTokens, isProcessing, onCompact, className }: ContextUsageIndicatorProps) {
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState<ContextIndicatorSettings>()
  useEffect(() => {
    if (!useClaudeSettings) return
    let active = true
    const refresh = () => {
      void Promise.all([window.electronAPI.getEnable1MContext(), window.electronAPI.getAutoCompactWindow()])
        .then(([enable1MContext, autoCompactWindow]) => {
          if (active) setSettings({ enable1MContext, autoCompactWindow })
        }).catch(() => { if (active) setSettings(undefined) })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => { active = false; window.removeEventListener('focus', refresh) }
  }, [useClaudeSettings, open])
  const value = contextIndicatorValues(snapshot, modelContextWindow, reportedContextWindow, useClaudeSettings ? settings : undefined)
  const cache = count(currentCacheTokens)
  const known = value.percent !== null && !value.stale
  const isChat = appearance === 'chat'
  const size = isChat ? 14 : 16
  const radius = isChat ? 6 : 5.5
  const strokeWidth = isChat ? 2 : 1.8
  const circle = 2 * Math.PI * radius
  const progressStroke = isChat
    ? value.percent !== null && value.percent > 90 ? '#ef4444' : '#a1a1aa'
    : 'currentColor'
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button type="button" className={cn('input-toolbar-btn inline-flex h-control w-control shrink-0 items-center justify-center rounded-full p-0 text-tertiary hover:bg-foreground/5 hover:text-foreground', known && value.percent! >= 90 && 'text-info', className)} aria-label={`Context usage ${known ? `${value.percent}%` : 'unknown'}`}>
        <svg viewBox={`0 0 ${size} ${size}`} className={cn(isChat ? 'size-3.5' : 'size-4', '-rotate-90')} aria-hidden="true">
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={isChat ? 'var(--border)' : 'currentColor'} strokeWidth={strokeWidth} opacity={isChat ? 1 : 0.2} strokeDasharray={known ? undefined : '2 3'} />
          {known && <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={progressStroke} strokeWidth={strokeWidth} strokeLinecap={isChat ? 'butt' : 'round'} strokeDasharray={`${circle * Math.min(100, value.percent!) / 100} ${circle}`} />}
        </svg>
      </button>
    </PopoverTrigger>
    <PopoverContent side="top" align="end" sideOffset={8} className={cn('text-xs', isChat ? 'w-[320px] rounded-[8px] p-3' : 'w-[280px] p-3.5')}>
      <div className="font-medium text-sm text-foreground">Context</div>
      {modelName && <div className="mt-0.5 text-tertiary">{modelName}</div>}
      <div className="mt-3 space-y-2">
        <div className="flex justify-between gap-4"><span className="text-secondary">Current usage</span><span className="tabular-nums">{value.used === null ? 'Not available' : `${tokenLabel(value.used)} tokens`}{value.estimate && value.used !== null ? ' · estimated' : ''}</span></div>
        {value.contextWindow !== null && <div className="flex justify-between gap-4"><span className="text-secondary">Context window</span><span className="tabular-nums">{tokenLabel(value.contextWindow)} tokens</span></div>}
        {(value.limitKind === 'compaction' || value.contextWindow === null) && <div className="flex justify-between gap-4"><span className="text-secondary">{value.limitKind === 'compaction' ? 'Auto-compaction' : 'Context window'}</span><span className="tabular-nums">{value.limit === null ? 'Not available' : `${tokenLabel(value.limit)} tokens`}</span></div>}
        {value.contextWindow === null && value.modelWindow !== null && value.modelWindow !== value.limit && <div className="flex justify-between gap-4"><span className="text-secondary">Model capacity</span><span className="tabular-nums">{tokenLabel(value.modelWindow)} tokens</span></div>}
        {value.percent !== null && <div className="flex justify-between gap-4"><span className="text-secondary">{value.limitKind === 'compaction' ? 'Used before compaction' : 'Used'}</span><span className="tabular-nums">{value.percent}%{value.stale ? ' · out of date' : ''}</span></div>}
        {cache !== null && <div className="flex justify-between gap-4"><span className="text-secondary">Cached in current context</span><span className="tabular-nums">{tokenLabel(cache)} tokens</span></div>}
      </div>
      <div className="mt-3 text-[11px] leading-relaxed text-tertiary">{value.stale ? 'Context changed; waiting for a fresh measurement.' : value.used === null ? 'Available after the agent reports a context measurement.' : 'Current context occupancy. This is separate from cumulative billed tokens.'}{updatedAt ? ` Updated ${new Date(updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''}</div>
      {snapshot?.canCompact && onCompact && <button type="button" disabled={isProcessing} onClick={onCompact} className="mt-3 w-full rounded-md bg-foreground/5 py-1.5 text-secondary hover:bg-foreground/10 disabled:opacity-40">{isProcessing ? 'Wait for the agent to finish' : 'Compact context'}</button>}
    </PopoverContent>
  </Popover>
}
