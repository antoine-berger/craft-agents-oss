import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, FileText, GitBranch, Maximize2, MoreHorizontal, RotateCcw } from 'lucide-react'
import { cn } from '../../../lib/utils'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '../../ui/StyledDropdown'
import { TurnIconButton } from './TurnIconButton'
import { HOVER_REVEAL } from './turn-classes'
import { formatDuration } from '../turn-utils'

export interface ResponseFooterProps {
  /** Whether the copy action just succeeded (shows ✓ for 2s) */
  copied: boolean
  timestamp?: number
  durationMs?: number
  onCopy: () => void
  /** Open the raw markdown in the code viewer */
  onPopOut?: () => void
  /** Open the fullscreen reader */
  onViewFullscreen?: () => void
  onBranch?: (options?: { newPanel?: boolean }) => void
  onRestore?: () => void
  /**
   * 'answer': quiet icon row under the answer, revealed on hover/focus of the answer.
   * 'plan': bottom bar of the plan card, always visible (it holds the Accept action).
   */
  variant: 'answer' | 'plan'
  /** Right-aligned content (Accept plan) */
  trailing?: React.ReactNode
}

/** Quiet timing and copy/reset controls; secondary actions share one menu. */
export function ResponseFooter({
  copied,
  timestamp,
  durationMs,
  onCopy,
  onPopOut,
  onViewFullscreen,
  onBranch,
  onRestore,
  variant,
  trailing,
}: ResponseFooterProps) {
  const { t } = useTranslation()
  const copyLabel = copied ? t('common.copied') : t('common.copy')

  return (
    <div
      className={cn(
        'flex min-h-6 min-w-0 items-center gap-2 text-[11px] text-tertiary',
        variant === 'answer'
          ? '-ml-1'
          : 'border-t border-subtle px-2 py-1.5'
      )}
    >
      {(durationMs != null && durationMs > 0) && <span className="pl-1 tabular-nums">{formatDuration(durationMs)}</span>}
      {timestamp != null && <time dateTime={new Date(timestamp).toISOString()} title={new Date(timestamp).toLocaleString()} className="tabular-nums">{new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}
      <div data-touch-reveal="true" className={cn('flex items-center gap-0.5', variant === 'answer' && HOVER_REVEAL, 'group-hover/answer:opacity-100 group-focus-within/answer:opacity-100')}>
      <TurnIconButton
        aria-label={copyLabel}
        tooltip
        icon={copied ? <Check className="size-3.5 text-success" /> : <Copy />}
        onClick={onCopy}
        className="turn-action-btn select-none"
      />
      {onRestore && (
        <TurnIconButton
          aria-label={t('checkpoints.returnHere', { defaultValue: 'Restore to this reply' })}
          tooltip
          icon={<RotateCcw />}
          onClick={onRestore}
          className="turn-action-btn select-none"
        />
      )}
      {(onPopOut || onViewFullscreen || onBranch) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <TurnIconButton aria-label={t('turnCard.moreActions')} icon={<MoreHorizontal />} className="turn-action-btn" />
          </DropdownMenuTrigger>
          <StyledDropdownMenuContent align="start" minWidth="min-w-48" sideOffset={6}>
            {onPopOut && <StyledDropdownMenuItem onClick={onPopOut}><FileText className="size-3.5" />{t('turnCard.viewAsMarkdown')}</StyledDropdownMenuItem>}
            {onViewFullscreen && <StyledDropdownMenuItem onClick={onViewFullscreen}><Maximize2 className="size-3.5" />{t('common.viewFullscreen')}</StyledDropdownMenuItem>}
            {onBranch && <StyledDropdownMenuItem onClick={() => onBranch({ newPanel: true })}><GitBranch className="size-3.5" />{t('chat.branchFromThisMessage')}</StyledDropdownMenuItem>}
          </StyledDropdownMenuContent>
        </DropdownMenu>
      )}
      </div>
      {trailing && <div className="ml-auto flex shrink-0 items-center">{trailing}</div>}
    </div>
  )
}
