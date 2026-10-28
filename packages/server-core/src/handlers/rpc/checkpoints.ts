import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [RPC_CHANNELS.sessions.LIST_CHECKPOINTS, RPC_CHANNELS.sessions.RESTORE_CHECKPOINT, RPC_CHANNELS.sessions.ADOPT_CHECKPOINT_WORKTREE] as const
export function registerCheckpointHandlers(server: RpcServer, deps: HandlerDeps): void {
  const authorize = (workspaceId: string | null | undefined, sessionId: string) => {
    const session = deps.sessionManager.getSessionSnapshot(sessionId)
    if (!session) throw new Error('Session not found')
    if (workspaceId) {
      const requested = getWorkspaceByNameOrId(workspaceId)
      const actual = getWorkspaceByNameOrId(session.workspaceId)
      if (!requested || !actual || requested.rootPath !== actual.rootPath) throw new Error('Session is in another workspace')
    }
  }
  server.handle(RPC_CHANNELS.sessions.LIST_CHECKPOINTS, async (ctx, sessionId: string) => {
    await deps.sessionManager.waitForInit(); authorize(ctx.workspaceId, sessionId)
    return deps.sessionManager.listSessionCheckpoints(sessionId)
  })
  server.handle(RPC_CHANNELS.sessions.ADOPT_CHECKPOINT_WORKTREE, async (ctx, sessionId: string) => {
    await deps.sessionManager.waitForInit()
    const workspaceId = ctx.workspaceId ?? (ctx.webContentsId != null ? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId) : undefined)
    if (!workspaceId) throw new Error('Open this session from its workspace before associating a checkout')
    authorize(workspaceId, sessionId)
    return deps.sessionManager.adoptSessionCheckpointWorktree(sessionId)
  })
  server.handle(RPC_CHANNELS.sessions.RESTORE_CHECKPOINT, async (ctx, sessionId: string, checkpointId: string) => {
    await deps.sessionManager.waitForInit(); authorize(ctx.workspaceId, sessionId)
    return deps.sessionManager.restoreSessionCheckpoint(sessionId, checkpointId)
  })
}
