import type { ShipPlanPreview, ShipWorkflowAPI, ShipWorkflowState } from '../../../../../packages/shared/src/protocol/ship-workflow'

/** RPC responses may arrive after a newer workspace push. Keep the newest persisted revision. */
export function newerShipWorkflowState(current: ShipWorkflowState | null, next: ShipWorkflowState | null): ShipWorkflowState | null {
  if (!next) return current
  if (current?.id === next.id && current.revision > next.revision) return current
  if (current && current.id !== next.id && current.createdAt >= next.createdAt) return current
  return next
}

/** Subscribe before fetching so a delayed empty snapshot cannot erase a newly started workflow. */
export function observeShipWorkflow(
  api: Pick<ShipWorkflowAPI, 'getShipWorkflow' | 'onShipWorkflowChanged'>,
  workspaceId: string,
  sessionId: string,
  onState: (state: ShipWorkflowState | null) => void,
  onError: () => void,
): () => void {
  let active = true, receivedUpdate = false
  let current: ShipWorkflowState | null = null
  onState(null)
  function accept(next: ShipWorkflowState): void {
    if (!active || ![next.sessionId, next.orchestratorSessionId].includes(sessionId)) return
    const accepted = newerShipWorkflowState(current, next)
    if (accepted === current) return
    current = accepted; onState(current)
  }
  const unsubscribe = api.onShipWorkflowChanged?.((workspace, state) => {
    if (!active || workspace !== workspaceId || ![state.sessionId, state.orchestratorSessionId].includes(sessionId)) return
    receivedUpdate = true; accept(state)
  })
  void api.getShipWorkflow(workspaceId, sessionId).then(state => {
    if (!active) return
    if (state) accept(state)
    else if (!receivedUpdate) onState(null)
  }).catch(() => { if (active && !receivedUpdate) onError() })
  return () => { active = false; unsubscribe?.() }
}

/** Decode only a bounded, complete set of server-chosen plan artifacts. Never render as HTML. */
export function decodeShipPlanPreview(preview: ShipPlanPreview): Record<'plan.md' | 'brief.md' | 'contract.md', string> {
  const names = ['plan.md', 'brief.md', 'contract.md'] as const
  if (!preview || !Array.isArray(preview.files) || preview.files.length !== names.length || preview.totalBytes > 4 * 1024 * 1024) throw new Error('Invalid or oversized plan preview')
  const files = {} as Record<typeof names[number], string>
  let total = 0
  for (const name of names) {
    const file = preview.files.find(file => file.name === name)
    if (!file || typeof file.contentBase64 !== 'string' || file.contentBase64.length > 6 * 1024 * 1024 || file.size < 0 || file.size > 4 * 1024 * 1024) throw new Error('Incomplete or oversized plan preview')
    const binary = atob(file.contentBase64)
    if (binary.length !== file.size) throw new Error('Plan preview size mismatch')
    total += binary.length; if (total > 4 * 1024 * 1024) throw new Error('Oversized plan preview')
    files[name] = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, character => character.charCodeAt(0)))
  }
  if (total !== preview.totalBytes) throw new Error('Plan preview total mismatch')
  return files
}
