import { Hand } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import type { SessionAttention } from '@craft-agent/shared/protocol'

/** Reasons are concrete and actionable; opening the chat does not dismiss this badge. */
export function SessionAttentionBadge({ attention, onOpen }: { attention: SessionAttention; onOpen: () => void }) {
  const { t } = useTranslation()
  return <Tooltip>
    <TooltipTrigger asChild>
      <span className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 bg-info/15 text-info text-[10px] font-semibold" aria-label={attention.reasons.map(r => r.title).join('; ')}>
        <Hand className="size-3" aria-hidden="true" />
        {t('attention.needsYou', { defaultValue: 'Needs you' })}
        {attention.reasons.length > 1 ? ` · ${attention.reasons.length}` : ''}
      </span>
    </TooltipTrigger>
    <TooltipContent side="right" className="max-w-sm p-3">
      <div className="flex flex-col gap-2">
        {attention.reasons.map(reason => <div key={reason.id} className="text-xs">
          <div className="font-semibold">{reason.title}</div>
          <div className="text-muted-foreground capitalize">{reason.source}</div>
          {reason.detail && <div className="whitespace-pre-wrap max-h-40 overflow-auto mt-1">{reason.detail}</div>}
          <button type="button" className="underline mt-1" onClick={e => {
            e.stopPropagation()
            if (reason.action.type === 'external' && reason.action.url && /^https:\/\//.test(reason.action.url)) void window.electronAPI.openUrl(reason.action.url)
            else onOpen()
          }}>{t('attention.openAction', { defaultValue: 'Open action' })}</button>
        </div>)}
        {attention.githubStale && <div className="text-xs text-muted-foreground">{t('attention.stale', { defaultValue: 'GitHub could not be refreshed. Previous requests are retained.' })}</div>}
      </div>
    </TooltipContent>
  </Tooltip>
}
