/**
 * Glyphs and tone classes shared by the PR chip and its card. The conflict glyph and highlight
 * color match Conductor; the other tones use the app's role colors.
 */

import * as React from 'react'
import {
  AlertTriangle,
  CircleCheck,
  CircleX,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquareWarning,
  ListOrdered,
  MinusCircle,
  createLucideIcon,
  type LucideIcon,
} from 'lucide-react'
import { Spinner } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import type { CheckStatus, PrChipStatus, PrIconState, PrState, PrTone } from './pr-watch-state'

export const TONE_TEXT: Record<PrTone, string> = {
  success: 'text-success',
  merged: 'text-merged',
  destructive: 'text-destructive',
  warning: 'text-[#cca694] dark:text-[#ddc1b1]',
  info: 'text-info',
  neutral: 'text-tertiary',
}

export const PR_STATE_ICON: Record<PrState, LucideIcon> = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
}

// Conductor's conflict glyph crosses the left branch; this differs from Lucide's closed-PR icon.
const MergeConflictIcon = createLucideIcon('git-pull-request-conflict', [
  ['path', { d: 'M12 6h4a2 2 0 0 1 2 2v7', key: 'right-branch' }],
  ['path', { d: 'M6 12v9', key: 'left-branch' }],
  ['path', { d: 'M9 3 3 9', key: 'cross-down' }],
  ['path', { d: 'M9 9 3 3', key: 'cross-up' }],
  ['circle', { cx: '18', cy: '18', r: '3', key: 'right-node' }],
])

export const PR_STATUS_ICON: Record<PrIconState, LucideIcon> = {
  ...PR_STATE_ICON,
  conflicting: MergeConflictIcon,
  behind: GitPullRequestArrow,
  queued: ListOrdered,
}

const STATUS_GLYPH: Record<Exclude<PrChipStatus, 'pending'>, { icon: LucideIcon; tone: string }> = {
  resolve: { icon: AlertTriangle, tone: 'text-destructive' },
  fix: { icon: MessageSquareWarning, tone: 'text-info' },
  'fix-ci': { icon: CircleX, tone: 'text-destructive' },
  unsynced: { icon: CircleCheck, tone: 'text-info' },
  ok: { icon: CircleCheck, tone: 'text-success' },
}

/**
 * The chip's one status glyph (`prChipStatus`): conflicts ⚠, review feedback 💬, failing CI ✗,
 * running checks (spinner), all good ✓ (orange while local changes aren't in the PR). It follows the
 * card's action, so a tick means the same in both.
 */
export function PrStatusGlyph({ status, className }: { status: PrChipStatus | null; className?: string }) {
  if (!status) return null
  if (status === 'pending') return <Spinner className={cn('text-label-sm text-info', className)} />
  const { icon: Icon, tone } = STATUS_GLYPH[status]
  return <Icon className={cn('size-3.5 shrink-0', tone, className)} aria-hidden />
}

/** One check's status glyph in the card's check list. */
export function CheckStatusGlyph({ status }: { status: CheckStatus }) {
  switch (status) {
    case 'pending': return <Spinner className="text-label-sm text-info" />
    case 'success': return <CircleCheck className="size-3.5 shrink-0 text-success" aria-hidden />
    case 'failure': return <CircleX className="size-3.5 shrink-0 text-destructive" aria-hidden />
    case 'skipped': return <MinusCircle className="size-3.5 shrink-0 text-tertiary" aria-hidden />
  }
}
