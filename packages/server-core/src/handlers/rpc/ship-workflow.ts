import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import type { RpcServer, RequestContext } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { parseShipCommand, type ShipStartRequest, type ShipApprovalRequest, type ShipWorkflowState } from '../../../../shared/src/protocol/ship-workflow'
import { readShipPlanPreview } from '../../services/ship-workflow/store'
import { ShipWorkflowService } from '../../services/ship-workflow/service'

export const HANDLED_CHANNELS = ['ship:startPlan', 'ship:get', 'ship:advance', 'ship:refresh', 'ship:approve', 'ship:stop'] as const
export interface ShipApprovalConfirmation {
  workflowId: string; revision: number; decision: ShipApprovalRequest['decision']; title: string; ticket: string; head: string; planHash: string; reasons: string[]
}
export interface ShipHandlerOptions {
  /** Observability only; called after the workspace push for immediate Attention refresh. */
  onChanged?: (state: ShipWorkflowState) => void

  /** Must resolve only from a fresh interactive human confirmation. Absent callback fails closed. */
  confirmShipApproval?: (ctx: RequestContext, request: ShipApprovalConfirmation) => Promise<boolean>
}
export function registerShipWorkflowHandlers(server: RpcServer, deps: HandlerDeps, options: ShipHandlerOptions = {}) {
  const services = new Map<string, ShipWorkflowService>()
  async function forWorkspace(workspaceId: string): Promise<ShipWorkflowService> {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Ship workspace not found')
    await deps.sessionManager.waitForInit()
    let value = services.get(workspace.id)
    if (!value) { value = new ShipWorkflowService({ manager: deps.sessionManager, workspaceId: workspace.id, workspaceRoot: workspace.rootPath, onChange: state => { server.push('ship:changed', { to: 'workspace', workspaceId: workspace.id }, workspace.id, state); try { options.onChanged?.(state) } catch { deps.platform.logger.warn('Ship attention notification failed') } } }); services.set(workspace.id, value) }
    return value
  }
  async function service(ctx: RequestContext, workspaceId: string): Promise<ShipWorkflowService> {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace || ctx.workspaceId && getWorkspaceByNameOrId(ctx.workspaceId)?.rootPath !== workspace.rootPath) throw new Error('Ship workspace not available to this client')
    return forWorkspace(workspace.id)
  }
  server.handle('ship:startPlan', async (ctx, workspaceId: string, request: ShipStartRequest) => (await service(ctx, workspaceId)).start(request))
  server.handle('ship:get', async (ctx, workspaceId: string, sessionId: string) => {
    const manager = await service(ctx, workspaceId)
    const session = deps.sessionManager.getSessionSnapshot(sessionId)
    if (!session || getWorkspaceByNameOrId(session.workspaceId)?.rootPath !== getWorkspaceByNameOrId(workspaceId)?.rootPath) throw new Error('Session is in another workspace')
    const state = manager.getBySession(sessionId)
    const workspace = getWorkspaceByNameOrId(workspaceId)!
    if (state?.phase === 'discussion' && !state.job) return { ...state, planPreview: readShipPlanPreview(workspace.rootPath, state) }
    return state
  })
  server.handle('ship:advance', async (ctx, workspaceId: string, workflowId: string) => (await service(ctx, workspaceId)).advance(workflowId))
  server.handle('ship:refresh', async (ctx, workspaceId: string, workflowId: string) => (await service(ctx, workspaceId)).refresh(workflowId))
  server.handle('ship:stop', async (ctx, workspaceId: string, workflowId: string) => (await service(ctx, workspaceId)).stop(workflowId))
  server.handle('ship:approve', async (ctx, workspaceId: string, workflowId: string, request: ShipApprovalRequest): Promise<ShipWorkflowState> => {
    if (!options.confirmShipApproval) throw new Error('A desktop human confirmation is required. Approval through conversation or an agent tool is unavailable.')
    if (!request || !['go', 'override-g1'].includes(request.decision)) throw new Error('Choose a supported plan approval')
    const manager = await service(ctx, workspaceId)
    const state = await manager.refresh(workflowId)
    if (state.revision !== request.revision || state.phase !== 'discussion') throw new Error('The workflow changed. Refresh and review the current plan before approving.')
    const confirmed = await options.confirmShipApproval(ctx, { workflowId, revision: state.revision, decision: request.decision, title: state.title, ticket: state.ticket, head: state.head, planHash: state.planHash, reasons: state.gates.g1?.reasons || [] })
    if (!confirmed) throw new Error('Human approval was not confirmed')
    // Re-read/re-hash after the dialog: changes while it was open invalidate the approval.
    return manager.approve(workflowId, request, `human-ui:${ctx.clientId}`)
  })
  return {
    forWorkspace,
    async getBySession(workspaceId: string, sessionId: string) { return (await forWorkspace(workspaceId)).getBySession(sessionId) },
    async executeUserCommand(sessionId: string, command: NonNullable<ReturnType<typeof parseShipCommand>> | string) {
      const parsed = typeof command === 'string' ? parseShipCommand(command) : command
      if (!parsed) throw new Error('Not a native Ship command')
      const session = deps.sessionManager.getSessionSnapshot(sessionId)
      if (!session) throw new Error('Session not found')
      const workflow = await forWorkspace(session.workspaceId)
      if (parsed.kind === 'plan') return workflow.start({ sessionId, ticket: parsed.ticket })
      const state = workflow.getBySession(sessionId)
      if (!state) throw new Error('No approved Ship plan in this chat. Start with /ship-plan ISSUE-123.')
      return workflow.advance(state.id)
    },
  }

}
