import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [RPC_CHANNELS.sessions.LIST_CHECKPOINTS, RPC_CHANNELS.sessions.RESTORE_CHECKPOINT] as const
export function registerCheckpointHandlers(server: RpcServer, deps: HandlerDeps): void {
  const authorize = (workspaceId: string | null | undefined, sessionId: string) => {
    const session = deps.sessionManager.getSessionSnapshot(sessionId)
    if (!session) throw new Error('Session not found')
    if (workspaceId && getWorkspaceByNameOrId(workspaceId)?.rootPath !== getWorkspaceByNameOrId(session.workspaceId)?.rootPath) throw new Error('Session is in another workspace')
  }
  server.handle(RPC_CHANNELS.sessions.LIST_CHECKPOINTS, async (ctx, sessionId: string) => {
    await deps.sessionManager.waitForInit(); authorize(ctx.workspaceId, sessionId)
    return deps.sessionManager.listSessionCheckpoints(sessionId)
  })
  server.handle(RPC_CHANNELS.sessions.RESTORE_CHECKPOINT, async (ctx, sessionId: string, checkpointId: string) => {
    await deps.sessionManager.waitForInit(); authorize(ctx.workspaceId, sessionId)
    return deps.sessionManager.restoreSessionCheckpoint(sessionId, checkpointId)
  })
}
