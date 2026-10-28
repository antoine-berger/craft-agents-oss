import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { WORKTREE_STACK_CHANNELS } from '../../../../shared/src/protocol/worktree-stack'
import type { RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import { getWorktreeStack } from '../../services/repositories/worktree-stack'
import { getPrWatchRegistry } from './pr-watch'

export const HANDLED_CHANNELS = [WORKTREE_STACK_CHANNELS.GET] as const

export function registerWorktreeStackHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(WORKTREE_STACK_CHANNELS.GET, async (ctx, sessionId: string) => {
    await deps.sessionManager.waitForInit()
    const session = deps.sessionManager.getSessionSnapshot(sessionId)
    if (!session) throw new Error('Session not found.')
    const workspaceId = ctx.workspaceId ?? (ctx.webContentsId != null ? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId) : undefined)
    const caller = workspaceId ? getWorkspaceByNameOrId(workspaceId) : null
    const workspace = getWorkspaceByNameOrId(session.workspaceId)
    if (!caller || !workspace || caller.rootPath !== workspace.rootPath) throw new Error('Open this session from its workspace.')
    const parent = session.worktree?.stackParent
    const cached = parent?.parentSessionId ? getPrWatchRegistry()?.cachedSessionState(parent.parentSessionId) : null
    const branch = cached?.kind === 'ready' ? cached.prs.find(entry => entry.origin === 'branch')?.summary : undefined
    const parentMerged = branch?.headRef === parent?.branch && branch?.state === 'merged'
    return getWorktreeStack({
      session: { ...session, workingDirectory: deps.sessionManager.getSessionWorkingDirectory(session.id) ?? session.workingDirectory },
      sessions: deps.sessionManager.getSessions(session.workspaceId), parentMerged,
    })
  })
}
