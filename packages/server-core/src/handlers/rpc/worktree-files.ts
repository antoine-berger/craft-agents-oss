import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { WORKTREE_FILES_CHANNELS, type WorktreeFileWrite } from '../../../../shared/src/protocol/worktree-files'
import type { RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import { listWorktreeFiles, readWorktreeFile, writeWorktreeFile } from '../../services/worktree-files/files'

export const HANDLED_CHANNELS = Object.values(WORKTREE_FILES_CHANNELS)

export function registerWorktreeFilesHandlers(server: RpcServer, deps: HandlerDeps): void {
  function authorize(workspaceId: string | null, sessionId: string, write = false): string {
    const session = deps.sessionManager.getSessionSnapshot(sessionId)
    if (!session) throw new Error('Session not found.')
    if (workspaceId) {
      const requested = getWorkspaceByNameOrId(workspaceId)
      const actual = getWorkspaceByNameOrId(session.workspaceId)
      if (!requested || !actual || requested.rootPath !== actual.rootPath) throw new Error('Session is in another workspace.')
    }
    if (write && session.isArchived) throw new Error('Unarchive this chat before editing its files.')
    const directory = deps.sessionManager.getSessionWorkingDirectory(sessionId) ?? session.workingDirectory
    if (!directory) throw new Error('This session has no worktree.')
    return directory
  }

  server.handle(WORKTREE_FILES_CHANNELS.LIST, async (ctx, sessionId: string, path = '') => {
    await deps.sessionManager.waitForInit()
    return listWorktreeFiles(authorize(ctx.workspaceId, sessionId), path)
  })
  server.handle(WORKTREE_FILES_CHANNELS.READ, async (ctx, sessionId: string, path: string) => {
    await deps.sessionManager.waitForInit()
    return readWorktreeFile(authorize(ctx.workspaceId, sessionId), path)
  })
  server.handle(WORKTREE_FILES_CHANNELS.WRITE, async (ctx, sessionId: string, input: WorktreeFileWrite) => {
    await deps.sessionManager.waitForInit()
    const directory = authorize(ctx.workspaceId, sessionId, true)
    return deps.sessionManager.withSessionWorktreeWrite(sessionId, () => writeWorktreeFile(directory, input, () => {
      if (authorize(ctx.workspaceId, sessionId, true) !== directory) throw new Error('The session changed worktree. Reopen the file before saving.')
    }))
  })
}
