/** The active PR's status and number; clicking opens its GitHub page directly. */
import { useTranslation } from 'react-i18next'
import { useAppShellContext } from '@/context/AppShellContext'
import { cn } from '@/lib/utils'
import type { PrWatchNav } from '@/hooks/usePrWatch'
import { mostUrgentStatus, prChipStatus, prIconState, sidebarPrTone, type PrChipStatus, type PrSummary, type PrWatchState } from './pr-watch-state'
import { PR_STATUS_ICON, TONE_TEXT } from './pr-watch-visuals'

export const PR_CHIP_RESERVE_PAD = 12

export interface ChatHeaderPrChipProps {
  state: PrWatchState
  nav?: PrWatchNav
  onReserveElChange?: (el: HTMLElement | null) => void
}

export function ChatHeaderPrChip({ state, nav, onReserveElChange }: ChatHeaderPrChipProps) {
  const { t } = useTranslation()
  const { onOpenUrl } = useAppShellContext()
  if (state.kind !== 'pr') return null

  const { summary } = state
  const status = summary.attentionStale ? null : prChipStatus(summary)
  const freshness = summary.attentionStale ? t('chat.prWatch.savedUnrefreshed') : null
  const multi = !!nav && nav.count > 1
  const others = multi ? nav.entries.filter((_, index) => index !== nav.index).map(entry => entry.summary) : []
  const othersStatus = mostUrgentStatus(others)
  const othersStatusSummary = othersStatus ? others.find(other => prChipStatus(other) === othersStatus) : undefined
  const iconState = prIconState(summary)
  const StateIcon = PR_STATUS_ICON[iconState]
  const stateLabel = iconState === 'conflicting' ? t('chat.prWatch.merge.conflicting')
    : iconState === 'behind' ? t('chat.prWatch.merge.behind')
    : iconState === 'queued' ? t('chat.queuedBadge')
    : t(`chat.prWatch.state.${summary.state}`)

  return (
    <span ref={onReserveElChange} className="inline-flex shrink-0 items-center">
      <button
        type="button"
        onClick={() => onOpenUrl(summary.url)}
        title={[t('chat.prWatch.openOnGitHub'), stateLabel, freshness].filter(Boolean).join(' · ')}
        aria-label={[
          t('chat.prWatch.openOnGitHub'),
          t('chat.prWatch.chipLabel', { number: summary.number, title: summary.title }),
          stateLabel,
          freshness,
          status && statusLabel(status, summary, t),
          multi && t('chat.prWatch.otherPrs', { count: nav.count - 1 }),
          othersStatus && othersStatusSummary && statusLabel(othersStatus, othersStatusSummary, t),
        ].filter(Boolean).join(' · ')}
        className={cn(
          // The header is a window drag region; keep the link clickable.
          'titlebar-no-drag inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-label-sm -outline-offset-2',
          'transition-[background-color] duration-micro ease-out-subtle hover:duration-instant',
          'hover:bg-fill-hover',
        )}
      >
        <span className="inline-flex shrink-0 items-center gap-1">
          <StateIcon className={cn('size-3.5 shrink-0', TONE_TEXT[sidebarPrTone(summary)])} aria-hidden />
          <span className="font-medium tabular-nums text-secondary">#{summary.number}</span>
          {multi && <span className="inline-flex items-center gap-0.5 text-caption tabular-nums text-tertiary">+{nav.count - 1}</span>}
        </span>
      </button>
    </span>
  )
}

/** The status glyph in words, for the chip's accessible name. */
function statusLabel(status: PrChipStatus, summary: PrSummary, t: (key: string, options?: Record<string, unknown>) => string): string {
  switch (status) {
    case 'resolve': return t('chat.prWatch.merge.conflicting')
    case 'fix': return summary.unresolvedThreads > 0
      ? t('chat.prWatch.openThreads', { count: summary.unresolvedThreads })
      : t('chat.prWatch.review.changesRequested')
    case 'fix-ci': return t('chat.prWatch.checks.failure')
    case 'pending': return t('chat.prWatch.checks.pending')
    case 'unsynced': return t('chat.prWatch.unsynced')
    case 'ok': return t('chat.prWatch.allGood')
  }
}
