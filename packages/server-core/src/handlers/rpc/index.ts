import { requestClientConfirmDialog } from '../../transport/capabilities'
import { registerShipWorkflowHandlers } from './ship-workflow'
import { registerSessionAttentionHandlers, getSessionAttentionService } from './session-attention'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

import { registerAuthHandlers } from './auth'
import { registerProviderQuotaHandlers } from './provider-quotas'
import { registerCliProxyHandlers } from './cli-proxy'
import { registerAutomationsHandlers } from './automations'
import { registerDecisionsHandlers } from './decisions'
import { registerFilesHandlers } from './files'
import { registerLabelsHandlers } from './labels'
import { registerLlmConnectionsHandlers } from './llm-connections'
import { registerOAuthHandlers } from './oauth'
import { registerResourcesHandlers } from './resources'
import { registerOnboardingHandlers } from './onboarding'
import { cleanupSessionFileWatchForClient, registerSessionsHandlers } from './sessions'
export { registerSessionsHandlers, cleanupSessionFileWatchForClient } from './sessions'
import { cleanupPrWatchForClient, registerPrWatchHandlers, getPrWatchRegistry } from './pr-watch'
import { registerRepositoryHandlers } from './repositories'
import { registerGitReviewHandlers } from './git-review'
import { registerConductorImportHandlers } from './conductor-import'
import { registerCheckpointHandlers } from './checkpoints'
import { registerServerHandlers } from './server'
import type { ServerHandlerContext } from '../../bootstrap/headless-start'
export type { ServerHandlerContext } from '../../bootstrap/headless-start'
export { getHealthCheck } from './server'
import { registerSettingsHandlers } from './settings'
import { registerProjectsHandlers } from './projects'
import { registerPagesHandlers } from './pages'
import { registerSkillsHandlers } from './skills'
import { registerSourcesHandlers } from './sources'
import { registerStatusesHandlers } from './statuses'
import { registerSystemCoreHandlers } from './system'
import { registerTasksHandlers } from './tasks'
import { registerTransferHandlers } from './transfer'
import { registerWorkspaceCoreHandlers } from './workspace'
import { registerMessagingHandlers } from './messaging'

export function registerCoreRpcHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  serverCtx?: ServerHandlerContext,
): void {
  registerAuthHandlers(server, deps)
  registerCliProxyHandlers(server, deps)
  registerProviderQuotaHandlers(server)
  registerAutomationsHandlers(server, deps)
  registerDecisionsHandlers(server, deps)
  registerFilesHandlers(server, deps)
  registerLabelsHandlers(server, deps)
  registerLlmConnectionsHandlers(server, deps)
  registerOAuthHandlers(server, deps)
  registerOnboardingHandlers(server, deps)
  registerResourcesHandlers(server, deps)
  registerSessionsHandlers(server, deps)
  if (serverCtx) registerServerHandlers(server, deps, serverCtx)
  registerSettingsHandlers(server, deps)
  registerProjectsHandlers(server, deps)
  registerPagesHandlers(server, deps)
  registerSessionAttentionHandlers(server, deps)
  registerPrWatchHandlers(server, deps)
  const prRegistry = getPrWatchRegistry()
  if (prRegistry) getSessionAttentionService()?.start(prRegistry)
  const ship = registerShipWorkflowHandlers(server, deps, {
    onChanged: () => { void getSessionAttentionService()?.sync() },
    confirmShipApproval: async (ctx, request) => {
      const answer = await requestClientConfirmDialog(server, ctx.clientId, {
        type: 'question', title: `Ship ${request.ticket}`,
        message: request.decision === 'override-g1' ? 'Approve this plan despite the unresolved plan checks?' : 'Approve this plan and authorize its implementation?',
        detail: `${request.title}\nRevision ${request.revision} · HEAD ${request.head.slice(0, 12)}\n${request.reasons.join('\n')}`,
        buttons: ['Approve', 'Cancel'], defaultId: 1, cancelId: 1,
      })
      return answer.response === 0
    },
  })
  deps.sessionManager.setWorkflowCommandHandler?.((sessionId, command) => ship.executeUserCommand(sessionId, command))
  registerRepositoryHandlers(server, deps)
  registerGitReviewHandlers(server, deps)
  registerCheckpointHandlers(server, deps)
  registerConductorImportHandlers(server, deps)
  registerSkillsHandlers(server, deps)
  registerSourcesHandlers(server, deps)
  registerStatusesHandlers(server, deps)
  registerSystemCoreHandlers(server, deps)
  registerTasksHandlers(server, deps)
  registerTransferHandlers(server)
  registerWorkspaceCoreHandlers(server, deps)
  registerMessagingHandlers(server, deps)
}

/** Per-client server state to drop when a client disconnects (session file watches, PR watches). */
export function cleanupRpcClientResources(clientId: string): void {
  cleanupSessionFileWatchForClient(clientId)
  cleanupPrWatchForClient(clientId)
}
