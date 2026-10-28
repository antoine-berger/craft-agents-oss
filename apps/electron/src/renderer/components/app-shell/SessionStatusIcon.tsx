import { GitBranch, Hand } from "lucide-react"
import { SessionActivity } from "./session-activity/SessionActivity"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { usePrWatch } from "@/hooks/usePrWatch"
import { PR_STATE_ICON, TONE_TEXT } from "./chat-header/pr-watch/pr-watch-visuals"
import { sidebarPrTone } from "./chat-header/pr-watch/pr-watch-state"
import type { SessionMeta } from "@/atoms/sessions"

interface SessionStatusIconProps {
  item: SessionMeta
  needsAttention?: boolean
  isWorking?: boolean
  isWaitingForSubagents?: boolean
  attentionDescription?: string
}

/** The branch's live PR state; attention and activity take priority in the same slot. */
export function SessionStatusIcon({ item, needsAttention = false, isWorking = false, isWaitingForSubagents = false, attentionDescription }: SessionStatusIconProps) {
  const { t } = useTranslation()
  const { state } = usePrWatch(item.id, true, item.workingDirectory)
  const pr = state.kind === 'pr' ? state.summary : undefined
  const Icon = pr ? PR_STATE_ICON[pr.state] : GitBranch
  const label = needsAttention ? attentionDescription || t("attention.needsYou")
    : isWaitingForSubagents ? t("session.runState.subagents", { defaultValue: 'Waiting for subagents' })
    : isWorking ? t("session.runState.working")
    : pr ? `#${pr.number} · ${t(`chat.prWatch.state.${pr.state}`)} · ${pr.title}`
    : item.worktree?.owned?.branch ?? 'Git branch'

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center [&>svg]:size-4",
        needsAttention ? "text-yellow-600 dark:text-yellow-400"
          : isWorking || !pr ? "text-secondary"
          : pr.state === 'closed' ? "text-destructive" : TONE_TEXT[sidebarPrTone(pr)],
      )}
    >
      {needsAttention ? <Hand aria-hidden="true" />
        : isWorking || isWaitingForSubagents ? <SessionActivity waiting={isWaitingForSubagents} />
        : <Icon aria-hidden="true" />}
    </span>
  )
}
