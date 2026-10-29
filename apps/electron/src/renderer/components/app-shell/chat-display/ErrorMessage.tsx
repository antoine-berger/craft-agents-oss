import * as React from "react"
import { useTranslation } from "react-i18next"
import { motion } from "motion/react"
import { ChevronRight, CircleAlert, CirclePause, Clock, KeyRound, LoaderCircle } from "lucide-react"
import { SPRING } from "@craft-agent/ui/motion"
import { Button } from "@/components/ui/button"
import { AnimatedCollapsibleContent } from "@/components/ui/collapsible"
import type { Message } from "../../../../shared/types"
import { handleErrorMessageAction } from "../error-message-actions"
import { stripRepeatedTitle } from "./strip-repeated-title"
import { chatMessageState, recordedLimitReset } from "./chat-message-state"

interface ErrorMessageProps {
  message: Message
  onOpenUrl?: (url: string) => void
  sessionId?: string
  onRetry?: () => void
  appearance?: 'default' | 'chat'
}

/**
 * ErrorMessage - inline error marker (spec §7.7): the same alert material as Info_Alert (destructive
 * tint, 1px destructive hairline, radius 12, 14px inset) — a 2px left rule on a rounded box tapered
 * into the corners like a bracket. Icon + title in the destructive role (600), body in the foreground
 * role, the recovery actions as buttons (the first one primary), raw details under a disclosure.
 */
export function ErrorMessage({ message, onOpenUrl, sessionId, onRetry, appearance = 'default' }: ErrorMessageProps) {
  const { t } = useTranslation()
  const hasDetails = (message.errorDetails && message.errorDetails.length > 0) || message.errorOriginal
  const [detailsOpen, setDetailsOpen] = React.useState(false)
  const actions = message.errorActions?.filter(a => {
    if (a.action === 'open_url') return !!a.url && !!onOpenUrl
    return true
  })
  const title = message.errorTitle || t('common.error')
  const reset = appearance === 'chat' ? recordedLimitReset(message.content) : undefined
  const body = reset ? `${message.content.split('|')[0]} · ${reset.toLocaleString()}` : stripRepeatedTitle(title, message.content)
  const state = chatMessageState(message)
  const chat = appearance === 'chat'
  const Icon = state === 'interrupted' ? CirclePause : state === 'retrying' ? LoaderCircle : state === 'limit' ? Clock : state === 'auth' ? KeyRound : CircleAlert
  const compactNotice = chat && (state === 'interrupted' || state === 'retrying')
  const visibleActions = chat && state === 'context' ? actions?.filter(action => action.action !== 'retry') : actions

  if (compactNotice) return (
    <div role="status" data-chat-message-state={state} className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-strong px-2 py-0.5 text-[12px] leading-4 text-secondary">
      <Icon aria-hidden className={state === 'retrying' ? 'size-3 shrink-0 motion-safe:animate-spin' : 'size-3 shrink-0'} />
      <span className="min-w-0 break-words">{message.content}</span>
    </div>
  )

  return (
    <div data-chat-message-state={chat ? state : undefined} className={chat ? 'flex min-w-0 flex-col items-start gap-2 text-[14px] leading-5' : 'flex min-w-0 gap-2.5 rounded-lg bg-destructive-tint inset-ring inset-ring-[var(--destructive-border)] px-3.5 py-3'}>
      {!chat && <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />}
      <div className="min-w-0 flex-1 break-words">
        <div className={chat ? 'inline-flex items-center gap-1.5 rounded-md border border-[var(--destructive-border)] bg-destructive-tint px-2 py-0.5 text-[12px] font-medium leading-4 text-destructive' : 'text-label font-semibold text-destructive'}>
          {chat && <Icon aria-hidden className="size-3 shrink-0" />}{title}
        </div>
        {body && <p className={chat ? "mt-2 text-[14px] leading-5 text-foreground" : "mt-0.5 text-label leading-5 text-foreground"}>{body}</p>}

        {/* Action buttons: one primary, the rest quiet */}
        {visibleActions && visibleActions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {visibleActions.map((action, index) => (
              <Button
                key={action.key}
                variant={chat ? 'outline' : index === 0 ? 'primary' : 'ghost'}
                size={chat ? "sm" : "md"}
                onClick={() => {
                  handleErrorMessageAction(action, {
                    sessionId,
                    onOpenUrl,
                    onRetry,
                  })
                }}
              >
                {action.label}{action.action === 'open_url' ? ' ↗' : ''}
              </Button>
            ))}
          </div>
        )}

        {/* Technical details, collapsed by default */}
        {hasDetails && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setDetailsOpen(!detailsOpen)}
              aria-expanded={detailsOpen}
              className="-ml-1 inline-flex min-h-control-sm in-data-compact:min-h-9 items-center gap-1 rounded-xs px-1 text-label-sm text-secondary transition-colors duration-micro ease-out-subtle hover:text-foreground hover:duration-instant"
            >
              <motion.span
                initial={false}
                animate={{ rotate: detailsOpen ? 90 : 0 }}
                transition={SPRING.snap}
                className="flex"
              >
                <ChevronRight aria-hidden className="size-3" />
              </motion.span>
              <span>{detailsOpen ? t('chat.hideTechnicalDetails') : t('chat.showTechnicalDetails')}</span>
            </button>

            <AnimatedCollapsibleContent isOpen={detailsOpen} className="overflow-hidden">
              <div className="mt-1.5 space-y-0.5 rounded-sm bg-sunken px-2.5 py-2 font-mono text-mono-ui text-secondary wrap-anywhere">
                {message.errorDetails?.map((detail, i) => (
                  <div key={i}>{detail}</div>
                ))}
                {message.errorOriginal && !message.errorDetails?.some(d => d.includes('Raw error:')) && (
                  <div className="mt-1">Raw: {message.errorOriginal.slice(0, 200)}{message.errorOriginal.length > 200 ? '...' : ''}</div>
                )}
              </div>
            </AnimatedCollapsibleContent>
          </div>
        )}
      </div>
    </div>
  )
}
