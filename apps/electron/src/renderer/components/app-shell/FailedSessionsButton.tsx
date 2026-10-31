import { useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import { RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import { canResumeFailedSession, sessionRecoveryReason } from '@craft-agent/shared/sessions/recovery'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { TopBarButton } from '../ui/TopBarButton'

export function FailedSessionsButton({ workspaceId }: { workspaceId: string | null }) {
  const { t } = useTranslation()
  const sessions = useAtomValue(sessionMetaMapAtom)
  const [restarting, setRestarting] = useState(false)
  const pending = useRef(false)
  const failed = [...sessions.values()].filter(session => session.workspaceId === workspaceId && canResumeFailedSession(session))
  const reasons = new Map<ReturnType<typeof sessionRecoveryReason>, number>()
  for (const session of failed) {
    const reason = sessionRecoveryReason(session.recovery!)
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
  }
  if (!failed.length && !restarting) return null
  const label = t('sessionRecovery.restart', { count: failed.length, defaultValue: 'Resume interrupted chats ({{count}})' })
  const reasonLabels = {
    server_restart: t('sessionRecovery.serverRestart', { defaultValue: 'Server interrupted' }),
    quota: t('sessionRecovery.quota', { defaultValue: 'Usage limit reached' }),
    authentication: t('sessionRecovery.authentication', { defaultValue: 'Authentication required' }),
    timeout: t('sessionRecovery.timeout', { defaultValue: 'Request timed out' }),
    connection: t('sessionRecovery.connection', { defaultValue: 'Connection lost' }),
    runtime: t('sessionRecovery.runtime', { defaultValue: 'Agent or command interrupted' }),
  }

  const restart = async () => {
    if (pending.current) return
    pending.current = true
    setRestarting(true)
    try {
      // One owner click, one attempt per failed chat. A persistent quota error reappears here.
      const results = await Promise.allSettled(failed.map(session => window.electronAPI.sessionCommand(session.id, { type: 'resumeFailed' })))
      const errors = results.filter(result => result.status === 'rejected').length
      if (errors) toast.error(t('sessionRecovery.retryFailed', { count: errors, defaultValue: 'Could not resume {{count}} chats.' }))
    } finally { pending.current = false; setRestarting(false) }
  }

  return <Tooltip>
    <TooltipTrigger asChild>
      <TopBarButton onClick={restart} disabled={restarting} className="ml-1 w-auto gap-1 px-2 text-amber-500"
        aria-label={label}>
        <RotateCcw className={restarting ? 'size-4 animate-spin' : 'size-4'} />
        {!!failed.length && <span className="text-label-sm tabular-nums">{failed.length}</span>}
      </TopBarButton>
    </TooltipTrigger>
    <TooltipContent side="bottom" className="w-64 flex-col items-stretch gap-2 p-3">
      <span className="font-medium">{label}</span>
      <dl className="space-y-1.5">
        {[...reasons].map(([reason, count]) => <div key={reason} className="flex items-center justify-between gap-3">
          <dt className="text-secondary">{reasonLabels[reason]}</dt>
          <dd className="tabular-nums">{count}</dd>
        </div>)}
      </dl>
      <span className="border-t border-border/50 pt-2 text-tertiary">{t('sessionRecovery.resumeAll', { defaultValue: 'Click to resume all' })}</span>
    </TooltipContent>
  </Tooltip>
}
