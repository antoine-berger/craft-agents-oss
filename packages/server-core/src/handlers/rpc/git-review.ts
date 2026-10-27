import type { RpcServer } from '@craft-agent/server-core/transport'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import type { HandlerDeps } from '../handler-deps'
import { getGitReview } from '../../services/git-review/review'

export const HANDLED_CHANNELS = ['git:getReview'] as const
export function registerGitReviewHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle('git:getReview', async (ctx, sessionId: string) => {
    const session = deps.sessionManager.getSessionSnapshot(sessionId)
    if (!session) throw new Error('Session not found')
    if (ctx.workspaceId && getWorkspaceByNameOrId(ctx.workspaceId)?.rootPath !== getWorkspaceByNameOrId(session.workspaceId)?.rootPath) throw new Error('Session is in another workspace')
    const directory = deps.sessionManager.getSessionWorkingDirectory(sessionId) ?? session.workingDirectory
    if (!directory) throw new Error('This session has no working directory')
    return getGitReview(directory, { baseRef: session.worktree?.owned?.base ?? session.worktree?.baseBranch, baseCommit: session.worktree?.owned?.baseCommit })
  })
}
