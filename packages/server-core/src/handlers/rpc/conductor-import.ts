import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { loadWorkspaceProjects } from '@craft-agent/shared/projects'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerDeps } from '../handler-deps'
import type { ConductorImportBundle, ConductorImportOptions } from '../../../../shared/src/protocol/conductor-import'
import { importConductorChat } from '../../services/conductor-import/service'

export const HANDLED_CHANNELS = ['conductor:import'] as const
export function registerConductorImportHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle('conductor:import', async (ctx, workspaceId: string, bundle: ConductorImportBundle, options?: ConductorImportOptions) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Craft workspace not found')
    if (ctx.workspaceId && getWorkspaceByNameOrId(ctx.workspaceId)?.rootPath !== workspace.rootPath) throw new Error('Target is in another workspace')
    await deps.sessionManager.waitForInit()
    const result = await importConductorChat(deps.sessionManager, workspace, bundle, options)
    if (result.status === 'imported') pushTyped(server, RPC_CHANNELS.projects.CHANGED, { to: 'workspace', workspaceId: workspace.id }, workspace.id, loadWorkspaceProjects(workspace.rootPath))
    return result
  })
}
