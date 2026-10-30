import { Hand } from 'lucide-react'
import { SessionActivity } from "./session-activity/SessionActivity"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { usePrWatch } from "@/hooks/usePrWatch"
import { PR_STATUS_ICON, PR_STATUS_COLOR, SESSION_STATUS_ICON, STATUS_COLOR } from "./conductor-status-icons"
import { prIconState } from "./chat-header/pr-watch/pr-watch-state"
import type { SessionMeta } from "@/atoms/sessions"
import type { SessionRunState } from "./session-run-state"

interface SessionStatusIconProps {
  item: SessionMeta
  runState?: SessionRunState
  attentionDescription?: string
}

/** The branch's live PR state; attention and activity take priority in the same slot. */
export function SessionStatusIcon({ item, runState, attentionDescription }: SessionStatusIconProps) {
  const { t } = useTranslation()
  const { state } = usePrWatch(item.id, true, item.workingDirectory, false)
  const pr = state.kind === 'pr' ? state.summary : undefined
  const iconState = pr ? prIconState(pr) : undefined
  const fallback = item.messageCount === 0 ? 'unstarted'
    : state.kind === 'unavailable' && state.reason === 'not-git' ? 'local' : 'branch'
  const isActive = runState === 'working' || runState === 'waiting'
  const needsAttention = runState === 'plan' || runState === 'permission' || runState === 'question'
  const Icon = runState === 'failed' ? SESSION_STATUS_ICON.failed
    : iconState ? PR_STATUS_ICON[iconState] : SESSION_STATUS_ICON[fallback]
  const prStateLabel = iconState === 'conflicting' ? t('chat.prWatch.merge.conflicting')
    : iconState === 'ready' ? t('chat.prWatch.merge.clean')
    : iconState === 'checks-failing' ? t('chat.prWatch.checks.failure')
    : iconState === 'queued' ? t('chat.queuedBadge')
    : pr ? t(`chat.prWatch.state.${pr.state}`) : ''
  const label = runState && !isActive ? attentionDescription || t("attention.needsYou")
    : runState === 'waiting' ? t("session.runState.subagents", { defaultValue: 'Waiting for subagents' })
    : isActive ? t("session.runState.working")
    : pr ? `#${pr.number} · ${prStateLabel} · ${pr.title}`
    : item.worktree?.owned?.branch ?? 'Git branch'

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center [&>svg]:size-3.5",
        needsAttention ? 'text-yellow-600 dark:text-yellow-400'
          : runState === 'failed' ? STATUS_COLOR.failed
          : runState || !iconState ? STATUS_COLOR.neutral
          : PR_STATUS_COLOR[iconState],
      )}
    >
      {needsAttention ? <Hand aria-hidden="true" />
        : isActive ? <SessionActivity waiting={runState === 'waiting'} />
        : <Icon aria-hidden="true" />}
    </span>
  )
}
