/** Host seam: apply before tool execution for a Ship task child. No network or model call. */
const READ_ONLY_ROLES = new Set(['planner', 'factcheck-code', 'factcheck-external', 'omissions', 'bugs', 'comments', 'performance'])
export function shipToolDenial(session: { taskSlug?: string; taskNodeId?: string }, name: string, input: unknown): string | null {
  if (!session.taskSlug?.startsWith('ship-')) return null
  const args = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const lower = name.toLowerCase()
  if (lower.includes('bash') || lower.includes('shell') || lower.includes('exec') || lower.startsWith('mcp')) {
    const command = typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : JSON.stringify(input)
    if (/\bgh\s+pr\s+merge\b|mergePullRequest|enqueuePullRequest|enablePullRequestAutoMerge|\/pulls\/\d+\/merge\b|\bgit\s+merge\b/i.test(command || '')) return 'Ship never merges or enqueues a PR, enables auto-merge, or merges the base branch.'
    if (/(?:\/review|\/claude-review)\b/.test(command || '') && /comment|review|graphql|api/i.test(command || '')) return 'Ship review requests use @claude only; /review and /claude-review are prohibited.'
    if (/\bgh\s+pr\s+create\b/.test(command || '') && !/(?:--draft\b|(?:^|\s)-d(?:\s|$))/.test(command || '')) return 'Ship PRs must be created as drafts.'
    if (/\bgh\s+pr\s+ready\b/.test(command || '')) return 'Only the native Ship server may mark a PR ready after exact-HEAD gates.'
  }
  if (session.taskNodeId === 'planner' && /^(write|edit|write_file|edit_file)$/i.test(name)) {
    const path = String(args.file_path || args.filePath || args.path || '').replaceAll('\\', '/')
    const suffix = `/tasks/${session.taskSlug}/ship/plan/`
    if (path.includes(suffix) && !path.includes('/../') && /^(ticket\.md|plan\.md|brief\.md|baseline\.md|claims\.jsonl|contract\.md)$/.test(path.slice(path.indexOf(suffix) + suffix.length))) return null
    return 'Before human go the Ship planner may write only the six native plan artifacts.'
  }
  if (!READ_ONLY_ROLES.has(session.taskNodeId || '')) return null
  if (/^(read|grep|glob|ls|webfetch|websearch|list_mcp_resources|read_mcp_resource)$/i.test(name)) return null
  if (lower.startsWith('mcp') && /(?:^|__)(?:get|list|search|read|fetch|query|describe)[_a-z]/i.test(name) && !/save|update|delete|create|send|post|write|execute|run_workflow/i.test(name)) return null
  if (lower.includes('bash') || lower.includes('shell')) {
    const command = String(args.command || args.cmd || '')
    if (/--(?:output|pre|ext-diff|textconv|open-files-in-pager|follow)(?:[=\s]|$)|(?:^|\s)-(?:o|f|F)(?:[=\s]|$)/.test(command)) return 'Reviewer shell commands cannot write files, execute preprocessors or start watchers.'
    if (!/[;&|<>`\n]|\$\(|\$\{|\\/.test(command) && /^(?:git\s+(?:diff|show|log|status|rev-parse|ls-files|grep)\b|rg\b|cat\s|head\s|tail\s|pwd$)/.test(command.trim())) return null
  }
  return 'This Ship reviewer is read-only. Use read tools and read-only connector calls; code changes and arbitrary execution belong to the builder.'
}
/** Generic Task controls must not bypass Ship's human gates. */
export function assertNotGenericShipRun(slug: string, workspaceRoot?: string): void {
  if (slug.startsWith('ship-') && (!workspaceRoot || readShipState(workspaceRoot, slug))) throw new Error('Use the native Ship workflow controls. Generic Task execution cannot bypass its gates.')
}

import { readRunLog } from '@craft-agent/shared/tasks'
import { resolve, relative, isAbsolute } from 'node:path'
import { findShipState, readShipArtifacts, readShipState, shipDirectory } from './store'
import { hashShipArtifacts } from './gates'
import { shipRoles } from './prompts'
import type { ShipWorkflowState } from '../../../../shared/src/protocol/ship-workflow'
export interface ShipSessionIdentity { id: string; taskSlug?: string; taskNodeId?: string; workingDirectory?: string }
function validHumanGo(state: ShipWorkflowState): boolean {
  return state.approvals.some(approval => approval.by.startsWith('human-ui:') && approval.planHash === state.planHash && (approval.decision === 'go' && state.gates.g1?.result === 'pass' && state.gates.g1.planHash === state.planHash || approval.decision === 'override-g1' && (state.gates.g1?.round || 0) >= 2))
}
/** Complete pre-tool boundary: phase, persisted native node attribution, immutable control files and human go. */
export function shipSessionToolDenial(workspaceRoot: string, identity: ShipSessionIdentity, name: string, input: unknown): string | null {
  let workflow: ShipWorkflowState | null = null
  const child = identity.taskSlug?.startsWith('ship-')
  try {
    workflow = child ? readShipState(workspaceRoot, identity.taskSlug!) : findShipState(workspaceRoot, identity.id)
    if (!workflow) return null
    const args = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    const controlDir = resolve(shipDirectory(workspaceRoot, workflow.id))
    const file = String(args.file_path || args.filePath || args.path || args.target_file || '')
    if (/^(write|edit|write_file|edit_file|apply_patch)$/i.test(name) && file) {
      const target = resolve(identity.workingDirectory || workspaceRoot, file)
      const location = relative(controlDir, target)
      const inside = !location.startsWith('..') && !isAbsolute(location)
      if (inside && !(identity.taskNodeId === 'planner' && location.startsWith('plan/'))) return 'Ship control state, approvals and reviewer outputs are server-owned.'
      const taskYaml = resolve(workspaceRoot, 'tasks', workflow.id, 'task.yaml')
      if (target === taskYaml) return 'The native Ship stage spec is server-owned; its roles cannot be replaced by a conversation.'
    }
    if (/bash|shell|exec/i.test(name)) {
      const command = String(args.command || args.cmd || '')
      if (command.includes(`/tasks/${workflow.id}/`) && /state\.json|events\.jsonl|task\.yaml|\/runs\//.test(command)) return 'Agents cannot mutate native Ship state, approvals, stage specs or attributed outputs.'
    }
    let role = identity.taskNodeId || 'pilot'
    if (child && identity.id !== workflow.orchestratorSessionId) {
      const job = workflow.job
      if (!job || !role || !job.roles.includes(role as never) || job.phase !== workflow.phase || !shipRoles(job.phase).includes(role as never)) return 'This Ship role is not authorized by the current persisted workflow phase.'
      const spawned = readRunLog(workspaceRoot, workflow.taskSlug, job.runId).findLast(entry => entry.kind === 'node-spawned' && entry.nodeId === role)
      if (!spawned || spawned.kind !== 'node-spawned' || spawned.sessionId !== identity.id || identity.id === workflow.sessionId) return 'This session is not the attributed native worker for this Ship role.'
      if (!['plan', 'g1'].includes(job.phase) && !validHumanGo(workflow)) return 'A persisted human approval of this exact plan is required before execution.'
      if (job.phase !== 'plan' && hashShipArtifacts(readShipArtifacts(workspaceRoot, workflow.id)) !== job.planHash) return 'Plan artifacts changed after this native step started. Stop and recheck before another tool.'
    } else {
      if (![workflow.sessionId, workflow.orchestratorSessionId].includes(identity.id)) return 'This session does not own this Ship workflow.'
      role = !validHumanGo(workflow) || ['plan', 'g1', 'discussion'].includes(workflow.phase) || workflow.status === 'running' ? 'factcheck-code' : 'pilot'
    }
    if (role === 'e2e') {
      const command = String(args.command || args.cmd || '')
      if (/bash|shell|exec/i.test(name) && /\bgit\s+(?:add|commit|push|reset|clean|checkout|switch|rebase|restore)\b/.test(command)) return 'The independent E2E worker cannot change or publish the reviewed Git tree.'
      if (/^mcp/i.test(name) && !/(?:^|__)(?:get|list|search|read|fetch|query|describe)[_a-z]/i.test(name)) return 'E2E production connectors are read-only. Local test writes belong to disposable boundaries.'
    }
    return shipToolDenial({ taskSlug: workflow.taskSlug, taskNodeId: role }, name, input)
  } catch {
    return 'Ship could not verify the persisted role, artifacts or human gate. No tool was executed.'
  }
}
