import { realpath, stat } from 'node:fs/promises'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { expandPath } from '@craft-agent/shared/utils'
import { TERMINAL_CHANNELS, type TerminalSize } from '@craft-agent/shared/protocol'
import type { RpcServer, RequestContext } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { runGit } from '../../services/git'
import { SessionTerminalService, type SessionTerminalDependencies } from '../../services/terminal/session-terminal'

export const HANDLED_CHANNELS = [TERMINAL_CHANNELS.OPEN, TERMINAL_CHANNELS.WRITE, TERMINAL_CHANNELS.RESIZE, TERMINAL_CHANNELS.CLOSE, TERMINAL_CHANNELS.DETACH] as const
let terminals: SessionTerminalService | undefined
let releaseResource: (() => void) | undefined
export function cleanupTerminalForClient(clientId: string): void { terminals?.dropClient(clientId) }
/** Call immediately after the archive/delete lock is acquired, and before checkout cleanup. */
export async function stopSessionTerminal(sessionId: string): Promise<void> { await terminals?.stopSession(sessionId) }
export async function disposeSessionTerminals(): Promise<void> {
  const previous = terminals
  await previous?.dispose()
  releaseResource?.(); releaseResource = undefined
  if (terminals === previous) terminals = undefined
}

export function registerTerminalHandlers(server: RpcServer, deps: HandlerDeps, overrides: Partial<SessionTerminalDependencies> = {}): SessionTerminalService {
  if (terminals) throw new Error('Terminal handlers are already registered. Dispose them before replacing the server.')
  function authorize(ctx: RequestContext, sessionId: string): void {
    const session = deps.sessionManager.getSessionSnapshot(sessionId)
    if (!session) throw new Error('Session not found.')
    const workspaceId = ctx.workspaceId ?? (ctx.webContentsId != null ? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId) : null)
    const callerWorkspace = workspaceId ? getWorkspaceByNameOrId(workspaceId) : null
    const sessionWorkspace = getWorkspaceByNameOrId(session.workspaceId)
    if (!callerWorkspace || !sessionWorkspace || callerWorkspace.rootPath !== sessionWorkspace.rootPath) throw new Error('Open this session from its workspace.')
    if (session.isArchived) throw new Error('Archived sessions cannot use a terminal.')
  }
  const current = new SessionTerminalService({
    async resolveSession(sessionId) {
      const session = deps.sessionManager.getSessionSnapshot(sessionId)
      if (!session || session.isArchived) throw new Error('This session is no longer available for a terminal.')
      const path = deps.sessionManager.getSessionWorkingDirectory(sessionId) ?? session.workingDirectory
      if (!path) throw new Error('Choose a repository and prepare this session’s worktree first.')
      const directory = await realpath(expandPath(path))
      if (!(await stat(directory)).isDirectory() || !await runGit(directory, ['rev-parse', '--show-toplevel'])) throw new Error('This session needs an existing Git worktree before opening a terminal.')
      return { workspaceId: session.workspaceId, directory }
    },
    async spawn(directory, size) {
      const { spawnSessionPty } = await import('../../services/terminal/node-pty')
      return spawnSessionPty(directory, size)
    },
    push(clientId, event) { server.push(TERMINAL_CHANNELS.CHANGED, { to: 'client', clientId }, event) },
    ...overrides,
  })
  terminals = current
  releaseResource = deps.sessionManager.registerWorktreeResource({
    hasRunningSession: id => current.hasRunningSession(id),
    stopSession: id => current.stopSession(id),
    async dispose() {
      await current.dispose()
      if (terminals === current) { terminals = undefined; releaseResource = undefined }
    },
  })
  server.handle(TERMINAL_CHANNELS.OPEN, (ctx, sessionId: string, size: TerminalSize) => { authorize(ctx, sessionId); return deps.sessionManager.withSessionWorktreeWrite(sessionId, () => current.open(sessionId, ctx.clientId, size)) })
  server.handle(TERMINAL_CHANNELS.WRITE, (ctx, sessionId: string, terminalId: string, data: string) => { authorize(ctx, sessionId); return current.write(sessionId, terminalId, ctx.clientId, data) })
  server.handle(TERMINAL_CHANNELS.RESIZE, (ctx, sessionId: string, terminalId: string, size: TerminalSize) => { authorize(ctx, sessionId); return current.resize(sessionId, terminalId, ctx.clientId, size) })
  server.handle(TERMINAL_CHANNELS.CLOSE, (ctx, sessionId: string, terminalId: string) => { authorize(ctx, sessionId); return current.close(sessionId, terminalId, ctx.clientId) })
  // A workspace switch/disconnect may detach a viewer after its old session was archived.
  server.handle(TERMINAL_CHANNELS.DETACH, (ctx, sessionId: string) => { current.detach(sessionId, ctx.clientId) })
  return current
}
