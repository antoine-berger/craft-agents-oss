import * as React from 'react'
import { ArrowDown, ArrowUp, Archive, ChevronDown, FlaskConical, GitMerge, GitPullRequestArrow, GitPullRequestDraft, GitPullRequestCreateArrow, ListOrdered, LoaderCircle, RotateCw, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import type { PrEntry, PrMergeMethod, PrQuickOperation, PrWatchState } from '@craft-agent/shared/protocol'
import { useAppShellContext } from '@/context/AppShellContext'
import { DropdownMenu, DropdownMenuTrigger, StyledDropdownMenuContent, StyledDropdownMenuItem } from '@/components/ui/styled-dropdown'
import { cn } from '@/lib/utils'
import type { PrAutoMergeChange } from '@/hooks/usePrWatch'
import { canRerunPrChecks, nextPrQuickAction, prQuickActionMessage, type PrQuickAction } from './pr-quick-actions'

const LABELS: Record<PrQuickAction, string> = {
  create: 'Create PR', 'commit-push': 'Commit and push', push: 'Push', pull: 'Pull', rebase: 'Rebase',
  resolve: 'Resolve', fix: 'Fix review', 'fix-ci': 'Fix CI', ready: 'Ready for review', rerun: 'Re-run',
  'auto-merge': 'Automerge', 'disable-auto-merge': 'Disable auto-merge', merge: 'Merge', queued: 'Queued', archive: 'Archive',
}
const ICONS = {
  create: GitPullRequestCreateArrow, 'commit-push': ArrowUp, push: ArrowUp, pull: ArrowDown, rebase: GitPullRequestArrow,
  resolve: GitMerge, fix: Wrench, 'fix-ci': FlaskConical, ready: GitPullRequestDraft, rerun: RotateCw,
  'auto-merge': GitMerge, 'disable-auto-merge': GitMerge, merge: GitMerge, queued: ListOrdered, archive: Archive,
}
const METHODS: Record<PrMergeMethod, string> = { merge: 'Merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge' }

export function PrQuickActions({ sessionId, state, origin, onRefresh, onSetAutoMerge }: {
  sessionId: string
  state: PrWatchState
  origin?: PrEntry['origin']
  onRefresh?: () => void
  onSetAutoMerge?: (ref: string, enabled: boolean, method?: PrMergeMethod) => Promise<PrAutoMergeChange>
}) {
  const { onSendMessage, onArchiveSession } = useAppShellContext()
  const [pending, setPending] = React.useState(false)
  const running = React.useRef(false)
  const primary = nextPrQuickAction(state, origin)
  const pr = state.kind === 'pr' ? state.summary : undefined
  const busy = pending
  const run = async (action: PrQuickAction, method?: PrMergeMethod) => {
    if (running.current || busy || action === 'queued') return
    running.current = true
    setPending(true)
    try {
      const message = prQuickActionMessage(action, state, origin)
      if (message) await onSendMessage(sessionId, message)
      else if (action === 'archive') await onArchiveSession(sessionId)
      else if (pr && (action === 'auto-merge' || action === 'disable-auto-merge')) {
        if (!onSetAutoMerge) throw new Error('Auto-merge is unavailable.')
        const result = await onSetAutoMerge(pr.url, action === 'auto-merge')
        if (!result.ok) throw new Error(result.error ?? 'Could not update auto-merge.')
      } else if (pr?.headOid && ['merge', 'ready', 'rerun'].includes(action)) {
        const result = await window.electronAPI.prWatchRunAction(sessionId, pr.url, {
          operation: action as PrQuickOperation, expectedHeadOid: pr.headOid, method,
        })
        if (!result.ok) throw new Error(result.error ?? 'PR action failed.')
        toast.success({ merged: 'PR merged', queued: 'PR added to merge queue', ready: 'PR ready for review', rerun: 'Failed checks restarted' }[result.outcome ?? 'rerun'])
      }
      onRefresh?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'PR action failed.')
    } finally {
      running.current = false
      setPending(false)
    }
  }
  if (!primary) return null
  const Icon = primary === 'merge' && pr?.quickActions?.mergeQueue ? ListOrdered : ICONS[primary]
  const queued = primary === 'queued'
  const merging = primary === 'merge'
  const label = merging && pr?.quickActions?.mergeQueue ? 'Add to queue' : LABELS[primary]
  const menuActions: PrQuickAction[] = []
  if (pr && canRerunPrChecks(pr)) menuActions.push('rerun')
  if (pr && pr.mergeState === 'behind' && primary !== 'rebase') menuActions.push('rebase')
  if (pr && pr.checks === 'failure' && primary !== 'fix-ci') menuActions.push('fix-ci')
  const methods = merging && !pr?.quickActions?.mergeQueue ? pr?.quickActions?.methods ?? [] : []
  const hasMenu = menuActions.length > 0 || methods.length > 1
  const buttonClass = 'titlebar-no-drag inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-label-sm transition-colors disabled:opacity-50 disabled:cursor-default'
  return <span className="inline-flex shrink-0 items-center gap-px">
    <button type="button" disabled={busy || queued} onClick={() => void run(primary)}
      title={queued ? `Merge queue: ${pr?.quickActions?.queued?.state} · position ${pr?.quickActions?.queued?.position}` : label}
      className={cn(buttonClass, merging ? 'bg-success/15 text-success hover:bg-success/25' : 'bg-foreground/5 text-secondary hover:bg-fill-hover', hasMenu && 'rounded-r-none')}>
      {pending ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <Icon className="size-3.5" aria-hidden />}
      {label}
    </button>
    {hasMenu && <DropdownMenu>
      <DropdownMenuTrigger asChild><button type="button" disabled={busy} aria-label="More PR actions" className={cn(buttonClass, 'rounded-l-none bg-foreground/5 px-1 hover:bg-fill-hover')}><ChevronDown className="size-3" /></button></DropdownMenuTrigger>
      <StyledDropdownMenuContent align="end" sideOffset={6}>
        {menuActions.map(action => <StyledDropdownMenuItem key={action} onSelect={() => void run(action)}>{LABELS[action]}</StyledDropdownMenuItem>)}
        {methods.map(method => <StyledDropdownMenuItem key={method} onSelect={() => void run('merge', method)}>{METHODS[method]}</StyledDropdownMenuItem>)}
      </StyledDropdownMenuContent>
    </DropdownMenu>}
  </span>
}
