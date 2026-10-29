import { ResponseFileChips } from './ResponseFileChips'
import type { ResponseUsage } from '@craft-agent/core/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../tooltip'
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
  appearance?: 'default' | 'chat'
  usage?: ResponseUsage
  changedFiles?: string[]
  onOpenFile?: (path: string) => void
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
  appearance = 'default',
  usage,
  changedFiles,
  onOpenFile,
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
  const usageRows = usage ? [
    ['Model', usage.model ?? usage.models?.join(', ')],
    ['Input tokens', usage.inputTokens], ['Output tokens', usage.outputTokens],
    ['Cache read', usage.cacheReadTokens], ['Cache write', usage.cacheCreationTokens],
    ['Speed', usage.fast === undefined ? undefined : usage.fast ? 'Fast' : 'Standard'],
  ].filter((row): row is [string, string | number] => row[1] !== undefined) : []
  const timing = <>
    {(durationMs != null && durationMs > 0) && <span className="tabular-nums">{formatDuration(durationMs)}</span>}
    {timestamp != null && <time dateTime={new Date(timestamp).toISOString()} title={new Date(timestamp).toLocaleString()} className="tabular-nums">{new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}
  </>
  const copyLabel = copied ? t('common.copied') : t('common.copy')

  return (
    <div className="@container min-w-0">
    <div
      className={cn(
        'flex min-h-6 min-w-0 flex-wrap items-center gap-2 text-tertiary',
        appearance === 'chat' ? 'text-[12px]' : 'text-[11px]',
        variant === 'answer'
          ? '-ml-1'
          : 'border-t border-subtle px-2 py-1.5'
      )}
    >
      {appearance === 'chat' && usageRows.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild><button type="button" aria-label="Response details" className="inline-flex items-center gap-1.5 rounded-sm px-1 text-left hover:bg-fill-hover focus-visible:outline focus-visible:outline-2">{timing}</button></TooltipTrigger>
          <TooltipContent side="top" className="w-64 p-3 text-xs font-normal">
            <dl className="w-full space-y-1.5">{usageRows.map(([label, value]) => <div key={label} className="flex justify-between gap-5"><dt className="text-secondary">{label}</dt><dd className="max-w-40 break-words text-right tabular-nums">{typeof value === 'number' ? value.toLocaleString() : value}</dd></div>)}</dl>
          </TooltipContent>
        </Tooltip>
      ) : <span className="inline-flex items-center gap-1.5 pl-1">{timing}</span>}
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
      {appearance === 'chat' && !!changedFiles?.length && <ResponseFileChips paths={changedFiles} onOpenFile={onOpenFile} />}
      {trailing && <div className="ml-auto flex shrink-0 items-center">{trailing}</div>}
    </div>

    </div>
  )
}
