import * as React from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ShipUsageAPI, ShipUsageSnapshot } from '../../../../../../packages/shared/src/protocol/ship-usage'

const amount = (value: number | null) => value === null ? '—' : new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)

/** This is measured reviewer activity, not a quota meter or a complete chat cost total. */
export function ShipUsageSection({ sessionId, api }: { sessionId: string; api: ShipUsageAPI }) {
  const [snapshot, setSnapshot] = React.useState<ShipUsageSnapshot | null>(null)
  const [error, setError] = React.useState<string>()
  const [loading, setLoading] = React.useState(false)
  const [revision, refresh] = React.useReducer(value => value + 1, 0)
  React.useEffect(() => {
    let cancelled = false
    setSnapshot(null); setError(undefined); setLoading(true)
    api.getShipUsage(sessionId).then(value => { if (!cancelled) setSnapshot(value) })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [sessionId, api, revision])
  if (!loading && !error && snapshot?.attempts.length === 0) return null
  return <section aria-label="Ship reviewer usage" className="space-y-2 border-t border-border p-3 text-xs">
    <div className="flex items-center justify-between"><span className="font-medium">Reviewer usage</span><Button variant="ghost" size="icon-sm" disabled={loading} aria-label="Refresh reviewer usage" onClick={refresh}><RefreshCw className="size-3.5" /></Button></div>
    <p className="text-secondary">Codex helper attempts in this worktree only. Native Claude steps are not included. Pool account: unknown.</p>
    {loading && <p role="status" className="text-secondary">Loading…</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {snapshot?.attempts.length === 0 && <p className="text-secondary">No measured reviewer attempts yet.</p>}
    {snapshot?.attempts.map(attempt => <div key={attempt.id} className="space-y-1 rounded border border-border p-2">
      <div className="flex items-center justify-between gap-2"><span>{attempt.role} · round {attempt.round}</span><span className={attempt.status === 'failed' ? 'text-destructive' : 'text-secondary'}>{attempt.status === 'failed' ? 'Failed' : `${Math.round(attempt.durationMs / 1000)}s`}</span></div>
      <p className="truncate text-secondary" title={`Requested: ${attempt.requestedModel}\nServed: ${attempt.servedModel ?? 'not reported'}`}>{attempt.requestedModel} · {attempt.effort} · CLIProxyAPI</p>
      <p className="text-secondary">Served: {attempt.servedModel ?? 'not reported'}</p>
      <div className="flex flex-wrap gap-x-3 text-secondary"><span>In {amount(attempt.inputTokens)}</span><span>Cached {amount(attempt.cacheReadTokens)}</span><span>Out {amount(attempt.outputTokens)}</span></div>
    </div>)}
    {snapshot?.truncated && <p className="text-secondary">Showing the bounded available history.</p>}
  </section>
}
