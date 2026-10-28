import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { SHIP_USAGE_CHANNELS } from '../../../../shared/src/protocol/ship-usage'
import type { RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import { readShipUsage } from '../../services/ship-usage'

export const HANDLED_CHANNELS = [SHIP_USAGE_CHANNELS.GET] as const
export function registerShipUsageHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(SHIP_USAGE_CHANNELS.GET, async (ctx, sessionId: string) => {
    await deps.sessionManager.waitForInit()
    const session = deps.sessionManager.getSessionSnapshot(sessionId)
    if (!session) throw new Error('Session not found.')
    const workspaceId = ctx.workspaceId ?? (ctx.webContentsId != null ? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId) : null)
    const caller = workspaceId ? getWorkspaceByNameOrId(workspaceId) : null
    const owner = getWorkspaceByNameOrId(session.workspaceId)
    if (!caller || !owner || caller.rootPath !== owner.rootPath) throw new Error('Open this session from its workspace.')
    const directory = deps.sessionManager.getSessionWorkingDirectory(sessionId) ?? session.workingDirectory
    return directory ? readShipUsage(directory) : { coverage: 'codex-helper-only', accountAttribution: 'unknown', attempts: [], truncated: false }
  })
}
