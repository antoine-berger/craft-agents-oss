import { useState } from 'react'
import { useAtomValue } from 'jotai'
import { RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import { canResumeFailedSession } from '@craft-agent/shared/sessions/recovery'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { TopBarButton } from '../ui/TopBarButton'

export function FailedSessionsButton({ workspaceId }: { workspaceId: string | null }) {
  const { t } = useTranslation()
  const sessions = useAtomValue(sessionMetaMapAtom)
  const [restarting, setRestarting] = useState(false)
  const failed = [...sessions.values()].filter(session => session.workspaceId === workspaceId && canResumeFailedSession(session))
  if (!failed.length && !restarting) return null

  const restart = async () => {
    if (restarting) return
    setRestarting(true)
    try {
      // One owner click, one attempt per failed chat. A persistent quota error reappears here.
      const results = await Promise.allSettled(failed.map(session => window.electronAPI.sessionCommand(session.id, { type: 'resumeFailed' })))
      const errors = results.filter(result => result.status === 'rejected').length
      if (errors) toast.error(t('sessionRecovery.retryFailed', { count: errors }))
    } finally { setRestarting(false) }
  }

  return <Tooltip>
    <TooltipTrigger asChild>
      <TopBarButton onClick={restart} disabled={restarting} className="ml-1 w-auto gap-1 px-2 text-amber-500"
        aria-label={t('sessionRecovery.restart', { count: failed.length })}>
        <RotateCcw className={restarting ? 'size-4 animate-spin' : 'size-4'} />
        {!!failed.length && <span className="text-label-sm tabular-nums">{failed.length}</span>}
      </TopBarButton>
    </TooltipTrigger>
    <TooltipContent side="bottom">{t('sessionRecovery.restart', { count: failed.length })}</TooltipContent>
  </Tooltip>
}
