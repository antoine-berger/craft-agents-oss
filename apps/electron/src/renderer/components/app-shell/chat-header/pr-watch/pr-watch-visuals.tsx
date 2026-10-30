/**
 * Shared PR glyphs; classic status indicators come from the verified Conductor definitions.
 */

import * as React from 'react'
import {
  AlertTriangle,
  CircleCheck,
  CircleX,
  MessageSquareWarning,
  MinusCircle,
  type LucideIcon,
} from 'lucide-react'
import { Spinner } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import type { CheckStatus, PrChipStatus, PrTone } from './pr-watch-state'

export const TONE_TEXT: Record<PrTone, string> = {
  success: 'text-success',
  merged: 'text-merged',
  destructive: 'text-destructive',
  info: 'text-info',
  neutral: 'text-tertiary',
}

export { PR_STATUS_ICON, PR_STATUS_COLOR } from '../../conductor-status-icons'
import { PR_STATUS_ICON } from '../../conductor-status-icons'
export const PR_STATE_ICON = { open: PR_STATUS_ICON.open, draft: PR_STATUS_ICON.draft, merged: PR_STATUS_ICON.merged, closed: PR_STATUS_ICON.closed }

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
