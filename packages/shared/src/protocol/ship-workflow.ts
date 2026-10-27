/** Native Craft Ship state. Human approvals are separate from conversation text. */
export const SHIP_PHASES = ['plan', 'g1', 'discussion', 'build', 'review', 'e2e', 'devin', 'human_review', 'done'] as const
export type ShipPhase = typeof SHIP_PHASES[number]
export type ShipGateName = 'g1' | 'review' | 'e2e'
export type ShipDecision = 'go' | 'override-g1'
export type ShipRole = 'planner' | 'factcheck-code' | 'factcheck-external' | 'omissions' | 'builder' | 'bugs' | 'comments' | 'performance' | 'e2e' | 'feedback'
export interface ShipModel { model: string; llmConnection?: string }
export interface ShipStartRequest { sessionId: string; ticket: string; title?: string; models?: Partial<Record<ShipRole, ShipModel>> }
export interface ShipApprovalRequest { revision: number; decision: ShipDecision }
export interface ShipGateResult { round: number; result: 'pass' | 'fail'; head: string; planHash: string; reasons: string[]; at: string; toFix?: Array<{ role: ShipRole; id: string; claim: string; evidence: string; fix: string }> }
export interface ShipApproval { decision: ShipDecision; at: string; revision: number; planHash: string; head: string; by: string }
export interface ShipJob { phase: ShipPhase; runId: string; round: number; head: string; planHash: string; roles: ShipRole[]; humanCommentIds?: string[] }
export interface ShipPRSnapshot {
  url: string; number: number; head: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; draft: boolean
  requiredCI: 'green' | 'red' | 'pending' | 'unknown'; conflicting: boolean
  botOpenThreads: number; humanOpenThreads: number; humanCommentIds: string[]
  botReviewEvidence?: 'head-review' | 'head-check' | 'not-configured' | 'grace-expired' | 'waiting';
  botReviewedHead: boolean; humanApprovedHead: boolean; checkedAt: string
}
export interface ShipPlanPreview {
  planHash: string
  totalBytes: number
  files: Array<{ name: 'plan.md' | 'brief.md' | 'contract.md'; contentBase64: string; size: number }>
}
export interface ShipWorkflowState {
  /** Display-only response from authenticated ship:get; never persisted or broadcast. */
  planPreview?: ShipPlanPreview

  version: 1; id: string; taskSlug: string; workspaceId: string; sessionId: string; orchestratorSessionId: string
  projectId?: string; ticket: string; title: string; repositoryPath: string; createdAt: string; updatedAt: string
  revision: number; phase: ShipPhase; status: 'idle' | 'running' | 'waiting' | 'blocked' | 'done'
  head: string; planHash: string; rounds: Partial<Record<ShipPhase, number>>; gates: Partial<Record<ShipGateName, ShipGateResult>>
  lastSummary?: { phase: ShipPhase; text: string }
  failures?: Partial<Record<ShipPhase, number>>;
  approvals: ShipApproval[]; models: Partial<Record<ShipRole, ShipModel>>; job?: ShipJob
  pr?: ShipPRSnapshot; seenHumanCommentIds: string[]; reasons: string[]
}
export interface ShipWorkflowAPI {
  startShipPlan(workspaceId: string, request: ShipStartRequest): Promise<ShipWorkflowState>
  getShipWorkflow(workspaceId: string, sessionId: string): Promise<ShipWorkflowState | null>
  advanceShipWorkflow(workspaceId: string, workflowId: string): Promise<ShipWorkflowState>
  refreshShipWorkflow(workspaceId: string, workflowId: string): Promise<ShipWorkflowState>
  approveShipWorkflow(workspaceId: string, workflowId: string, request: ShipApprovalRequest): Promise<ShipWorkflowState>
  onShipWorkflowChanged?(callback: (workspaceId: string, state: ShipWorkflowState) => void): () => void
  stopShipWorkflow(workspaceId: string, workflowId: string): Promise<ShipWorkflowState>
}
/** Parsing only: callers must start/resume the native workflow, never inject old Mac CLI commands. */
export function parseShipCommand(input: string): { kind: 'plan'; ticket: string } | { kind: 'resume' } | null {
  const text = input.trim()
  if (/^\/ship\s*$/i.test(text)) return { kind: 'resume' }
  const match = /^\/ship-plan\s+(.+)$/i.exec(text)
  if (!match) return null
  const raw = match[1]!.trim()
  if (/^[A-Za-z][A-Za-z0-9]*-[1-9]\d*$/.test(raw)) return { kind: 'plan', ticket: raw.toUpperCase() }
  try { const url = new URL(raw); const id = /^\/[\w-]+\/issue\/([A-Za-z][A-Za-z0-9]*-[1-9]\d*)(?:\/[^/]*)?\/?$/.exec(url.pathname); if (url.protocol === 'https:' && url.hostname === 'linear.app' && !url.username && !url.password && !url.port && !url.search && !url.hash && id) return { kind: 'plan', ticket: id[1]!.toUpperCase() } } catch { /* not a canonical issue URL */ }
  return null
}
