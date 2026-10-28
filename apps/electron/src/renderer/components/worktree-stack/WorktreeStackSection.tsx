import * as React from 'react'
import { ArrowDown, ArrowUp, GitBranch, RefreshCw } from 'lucide-react'
import type { WorktreeStackAPI, WorktreeStackSession, WorktreeStackSnapshot, WorktreeStackState } from '../../../../../../packages/shared/src/protocol/worktree-stack'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const LABEL: Record<WorktreeStackState, string> = {
  'up-to-date': 'Up to date', 'needs-restack': 'Needs restack', diverged: 'Parent history changed',
  'missing-parent': 'Parent unavailable', 'parent-switched': 'Parent changed branch', ambiguous: 'Parent ambiguous', unknown: 'Unknown', cycle: 'Invalid stack',
}

interface Props {
  sessionId: string
  api: WorktreeStackAPI
  onOpenSession?: (sessionId: string) => void
}

/** A local snapshot, refreshed by the owner; it never launches work or rewrites a branch. */
export function WorktreeStackSection({ sessionId, api, onOpenSession }: Props) {
  const [snapshot, setSnapshot] = React.useState<WorktreeStackSnapshot>()
  const [error, setError] = React.useState<string>()
  const [loading, setLoading] = React.useState(false)
  const [revision, refresh] = React.useReducer(value => value + 1, 0)
  React.useEffect(() => {
    let cancelled = false
    setSnapshot(undefined); setError(undefined); setLoading(true)
    api.getSessionStack(sessionId).then(value => { if (!cancelled) setSnapshot(value) }, cause => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [sessionId, api, revision])
  const entry = (session: WorktreeStackSession, direction: 'parent' | 'child') => <div key={session.sessionId} className="flex items-center gap-2 text-label-sm">
    {direction === 'parent' ? <ArrowUp className="size-3.5 shrink-0 text-secondary" /> : <ArrowDown className="size-3.5 shrink-0 text-secondary" />}
    <button type="button" disabled={!onOpenSession} onClick={() => onOpenSession?.(session.sessionId)} className="min-w-0 truncate text-left text-foreground enabled:hover:underline disabled:cursor-default" title={session.branch || session.title}>{session.title}</button>
    {session.archived && <span className="shrink-0 text-xs text-secondary">Archived</span>}
  </div>
  return <section aria-label="Branch stack" className="flex min-h-0 flex-col gap-3 overflow-auto p-3">
    <div className="flex items-center gap-2"><GitBranch className="size-4 text-secondary" /><h3 className="flex-1 text-label font-medium">Branch stack</h3><Button size="icon-sm" variant="ghost" aria-label="Refresh branch stack" disabled={loading} onClick={refresh}><RefreshCw className={cn('size-3.5', loading && 'animate-spin')} /></Button></div>
    {loading && <p role="status" className="text-label-sm text-secondary">Checking local branches…</p>}
    {error && <p role="alert" className="text-label-sm text-destructive">{error}</p>}
    {snapshot && <>
      {snapshot.reason && <p className="text-label-sm text-secondary">{snapshot.reason}</p>}
      {snapshot.parent ? <>
        <div className="space-y-2">
          <p className="break-all font-mono text-xs text-secondary">Based on {snapshot.parent.branch}</p>
          {snapshot.parent.session && entry(snapshot.parent.session, 'parent')}
          <p className={cn('text-label-sm', snapshot.parent.state === 'up-to-date' ? 'text-secondary' : 'text-yellow-600 dark:text-yellow-400')}>{LABEL[snapshot.parent.state]}{snapshot.parent.merged ? ' · Parent PR merged (cached)' : ''}</p>
          <p className="text-label-sm text-secondary">{snapshot.parent.detail}</p>
          <p className="font-mono text-xs text-tertiary" title={snapshot.parent.baseCommit}>Started at {snapshot.parent.baseCommit.slice(0, 12)}</p>
        </div>
      </> : snapshot.status === 'none' && <p className="text-label-sm text-secondary">No recorded parent. Copied branch starts record their base automatically.</p>}
      {snapshot.children.length > 0 && <div className="space-y-2 border-t border-border pt-3"><p className="text-xs text-secondary">Dependent sessions</p>{snapshot.children.map(child => entry(child, 'child'))}</div>}
      <p className="text-xs text-tertiary">Local evidence · no fetch or rebase</p>
    </>}
  </section>
}
