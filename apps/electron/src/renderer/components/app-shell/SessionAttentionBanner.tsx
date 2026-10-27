import { Hand } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionAttention } from '@craft-agent/shared/protocol'

/** Compact durable request above the conversation; never dismissed merely by opening it. */
export function SessionAttentionBanner({ attention, onOpenUrl }: {
  attention: SessionAttention | undefined
  onOpenUrl?: (url: string) => void
}) {
  const { t } = useTranslation()
  if (!attention || attention.status !== 'needs-human') return null
  return <section className="mx-4 mb-2 rounded-lg border border-info/20 bg-info/5 px-3 py-2 text-label" aria-label={t('attention.needsYou', { defaultValue: 'Needs you' })}>
    <div className="flex items-start gap-2">
      <Hand className="size-4 shrink-0 text-info mt-0.5" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-2">
        {attention.reasons.map(reason => <div key={reason.id}>
          <div className="flex gap-2 items-baseline">
            <span className="font-medium break-words">{reason.title}</span>
            <span className="text-caption text-tertiary shrink-0 capitalize">{reason.source}</span>
            {reason.action.type === 'external' && reason.action.url && /^https:\/\//.test(reason.action.url) && <button type="button" className="ml-auto text-caption underline shrink-0" onClick={() => {
              if (onOpenUrl) onOpenUrl(reason.action.url!)
              else void window.electronAPI.openUrl(reason.action.url!)
            }}>{t('attention.openAction', { defaultValue: 'Open action' })}</button>}
          </div>
          {reason.detail && <div className="text-secondary whitespace-pre-wrap break-words max-h-32 overflow-auto mt-0.5">{reason.detail}</div>}
        </div>)}
        {attention.githubStale && <div className="text-caption text-tertiary">{t('attention.stale', { defaultValue: 'GitHub could not be refreshed. Previous requests are retained.' })}</div>}
      </div>
    </div>
  </section>
}
