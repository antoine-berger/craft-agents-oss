import * as React from 'react'
import { Button } from '@/components/ui/button'
import { decodeShipPlanPreview, newerShipWorkflowState, observeShipWorkflow } from '@/lib/ship-workflow-state'
import type { ShipWorkflowAPI, ShipWorkflowState, ShipDecision } from '../../../../../../packages/shared/src/protocol/ship-workflow'
const LABELS = { plan: 'Plan', g1: 'Plan fact-check', discussion: 'Your approval', build: 'Build', review: 'Independent review', e2e: 'Local E2E', devin: 'GitHub feedback + CI', human_review: 'Human review', done: 'Complete' }
export function ShipWorkflowPanel({ workspaceId, sessionId, api, hideWhenEmpty = false }: { workspaceId: string; sessionId: string; api: ShipWorkflowAPI; hideWhenEmpty?: boolean }) {
  const [state, setState] = React.useState<ShipWorkflowState | null>(null)
  const [ticket, setTicket] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const generation = React.useRef(0)
  const [plan, setPlan] = React.useState<{ hash: string; files: Record<'plan.md' | 'brief.md' | 'contract.md', string> } | null>(null)
  const [planError, setPlanError] = React.useState('')
  const [planTab, setPlanTab] = React.useState<'plan.md' | 'brief.md' | 'contract.md'>('plan.md')
  React.useEffect(() => { generation.current++; setError(''); setBusy(false); const stop = observeShipWorkflow(api, workspaceId, sessionId, setState, () => setError('Unable to read the Ship workflow')); return () => { generation.current++; stop() } }, [workspaceId, sessionId, api])
  React.useEffect(() => {
    let active = true
    setPlan(null); setPlanError('')
    if (!state || state.phase !== 'discussion') return
    const expectedId = state.id
    void api.getShipWorkflow(workspaceId, sessionId).then(current => {
      if (!active) return
      if (!current || current.id !== expectedId || !current.planPreview) throw new Error('The complete plan is not available for review yet.')
      const files = decodeShipPlanPreview(current.planPreview)
      setPlan({ hash: current.planPreview.planHash, files })
    }).catch(error => { if (active) setPlanError(error instanceof Error ? error.message : 'Unable to load the complete plan') })
    return () => { active = false }
  }, [api, workspaceId, sessionId, state?.id, state?.phase, state?.planHash])
  async function action(fn: () => Promise<ShipWorkflowState | null>) {
    const requestGeneration = generation.current
    setBusy(true); setError('')
    try { const next = await fn(); if (requestGeneration === generation.current) setState(current => newerShipWorkflowState(current, next)) }
    catch (error) { if (requestGeneration === generation.current) setError(error instanceof Error ? error.message : 'Ship action failed') }
    finally { if (requestGeneration === generation.current) setBusy(false) }
  }
  async function approve(decision: ShipDecision) {
    if (!state || !plan || plan.hash !== state.planHash) return
    await action(async () => { const approved = await api.approveShipWorkflow(workspaceId, state.id, { revision: state.revision, decision }); return api.advanceShipWorkflow(workspaceId, approved.id) })
  }
  if (hideWhenEmpty && !state) return null
  return <div className="space-y-3 p-4">
    <div className="flex justify-between items-center gap-3"><h3 className="text-sm font-medium">Ship</h3>{state && <span className="text-xs text-muted-foreground">{state.ticket} · {state.status}</span>}</div>
    {!state ? <>
      <p className="text-xs text-muted-foreground">Plan, independent fact-check, your approval, implementation, review and E2E. Uses this project and its isolated worktree. Craft never merges.</p>
      <div className="flex gap-2"><input aria-label="Linear issue for Ship" className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-sm" placeholder="ENG-123 or Linear issue URL" value={ticket} onChange={event => setTicket(event.target.value)} disabled={busy} /><Button size="sm" disabled={busy || !ticket.trim()} onClick={() => void action(() => api.startShipPlan(workspaceId, { sessionId, ticket }))}>Plan</Button></div>
    </> : <>
      <ol className="space-y-1 text-xs">{Object.entries(LABELS).filter(([phase]) => phase !== 'done').map(([phase, label]) => <li key={phase} className={state.phase === phase ? 'font-medium text-foreground' : 'text-muted-foreground'}>{state.phase === phase ? '● ' : '○ '}{label}{state.rounds[phase as keyof typeof state.rounds] ? ` · round ${state.rounds[phase as keyof typeof state.rounds]}` : ''}</li>)}</ol>
      {state.lastSummary && <p className="text-xs text-muted-foreground">{state.lastSummary.text}</p>}
      {state.reasons.length > 0 && <div className="space-y-1 text-xs text-muted-foreground">{state.reasons.map((reason, i) => <p key={i}>{reason}</p>)}</div>}
      {state.phase === 'discussion' && <section className="space-y-2 rounded-md border p-3" aria-label="Review the proposed plan">
        <div className="flex gap-2" role="tablist" aria-label="Plan artifacts">{(['plan.md', 'brief.md', 'contract.md'] as const).map(name => <button key={name} role="tab" aria-selected={planTab === name} className={planTab === name ? 'text-xs font-medium underline underline-offset-4' : 'text-xs text-muted-foreground'} onClick={() => setPlanTab(name)}>{name === 'plan.md' ? 'Plan' : name === 'brief.md' ? 'Brief' : 'Acceptance contract'}</button>)}</div>
        {plan ? <pre role="tabpanel" aria-label={planTab} className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed">{plan.files[planTab]}</pre> : <p className="text-xs text-muted-foreground">{planError || 'Loading the complete plan for review…'}</p>}
        {plan && plan.hash !== state.planHash && <p className="text-xs text-destructive">Plan files changed. Refresh to fact-check and review the current version before approving.</p>}
      </section>}
      {state.gates.g1 && state.phase === 'discussion' && <div className="rounded-md border p-2 text-xs space-y-1"><p>{state.gates.g1.result === 'pass' ? 'Plan fact-check passed.' : 'Plan fact-check did not pass. Review the remaining issues before overriding.'}</p><p className="text-muted-foreground">Plan {state.planHash.slice(0, 12)} · HEAD {state.head.slice(0, 8)}</p><p className="text-muted-foreground">Approval requires a fresh human confirmation. A chat message cannot grant it.</p></div>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void action(() => api.refreshShipWorkflow(workspaceId, state.id))}>Refresh</Button>
        {state.phase === 'discussion' ? <Button size="sm" disabled={busy || !plan || plan.hash !== state.planHash} onClick={() => void approve(state.gates.g1?.result === 'pass' ? 'go' : 'override-g1')}>{state.gates.g1?.result === 'pass' ? 'Approve plan and build' : 'Review override and build'}</Button> : state.phase !== 'done' && state.phase !== 'human_review' && <Button size="sm" disabled={busy || state.status === 'running'} onClick={() => void action(() => api.advanceShipWorkflow(workspaceId, state.id))}>{state.phase === 'devin' ? 'Handle one feedback round' : 'Continue'}</Button>}
        {state.job && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action(() => api.stopShipWorkflow(workspaceId, state.id))}>Stop</Button>}
      </div>
      {state.pr && <a href={state.pr.url} className="text-xs underline underline-offset-2" target="_blank" rel="noreferrer">PR #{state.pr.number} · {state.pr.draft ? 'Draft' : 'Ready'} · CI {state.pr.requiredCI}</a>}
      {state.phase === 'human_review' && <p className="text-xs text-muted-foreground">The owner handles human review and merging on GitHub. Craft has no merge action.</p>}
    </>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>
}
