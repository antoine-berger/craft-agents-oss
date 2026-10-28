/**
 * PR watcher RPCs (chat-header PR carousel). The registry runs here, on the workspace
 * server: it has the session's folder, the source credentials and `gh`, so tokens never reach a
 * client. Clients subscribe per session and receive `prWatch:changed` pushes carrying the session's
 * whole PR set. Bind / unbind / auto-merge / auto-fix go through the shared ops so the agent tools and
 * the chip UI take exactly the same path. The auto-fix monitor (the Fix toggle) also lives here: it
 * holds its own registry subscriptions, so it runs whether or not a window shows the session.
 */

import { RPC_CHANNELS, type PrAutoFixResult, type PrQuickOperationRequest, type PrQuickOperationResult, type PrDetails, type PrMergeMethod, type PrWatchSessionState } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import type {
  PrBindToolResult,
  PrUnbindToolResult,
  PrAutoMergeToolResult,
} from '@craft-agent/session-tools-core'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { AUTO_FIX_CLIENT_ID, createAutoFixMonitor, type AutoFixMonitor } from '../../pr-watch/auto-fix'
import { createPrWatchOps } from '../../pr-watch/operations'
import { githubGraphql } from '../../services/pr-watch/github-client'
import { PrWatchRegistry } from '../../services/pr-watch/registry'
import { diskPrAssociations } from '../../services/pr-watch/association-store'
import { syncSessionTitleFromPr } from '../../services/pr-watch/session-title'
import { parsePrReference } from '../../services/pr-watch/pr-ref'
import { tokenCandidates, type GitHubSourceLike } from '../../services/pr-watch/token-chain'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.prWatch.SUBSCRIBE,
  RPC_CHANNELS.prWatch.UNSUBSCRIBE,
  RPC_CHANNELS.prWatch.REFRESH,
  RPC_CHANNELS.prWatch.GET_DETAILS,
  RPC_CHANNELS.prWatch.BIND,
  RPC_CHANNELS.prWatch.UNBIND,
  RPC_CHANNELS.prWatch.SET_AUTO_MERGE,
  RPC_CHANNELS.prWatch.SET_AUTO_FIX,
  RPC_CHANNELS.prWatch.RUN_ACTION,
] as const

let registry: PrWatchRegistry | null = null
let autoFixMonitor: AutoFixMonitor | null = null

/** The live registry instance, so the session-tool bridge (SessionManager) can reach it (D3). */
export function getPrWatchRegistry(): PrWatchRegistry | null {
  return registry
}

/** The live auto-fix monitor, so the tool bridge can re-sync it after an unbind. */
export function getPrAutoFixMonitor(): AutoFixMonitor | null {
  return autoFixMonitor
}

/** Drops a disconnected client's subscriptions (wired into the server's client cleanup). */
export function cleanupPrWatchForClient(clientId: string): void {
  registry?.dropClient(clientId)
}

const resolveWorkspaceRootPath = (workspaceId: string) => getWorkspaceByNameOrId(workspaceId)?.rootPath ?? null

/**
 * The workspace's GitHub sources (API or MCP, enabled) as token candidates. OAuth tokens go through
 * the refresh manager; a source without a stored credential is skipped without touching it.
 */
async function loadGitHubSources(workspaceRootPath: string): Promise<GitHubSourceLike[]> {
  const { loadWorkspaceSources, getSourceCredentialManager, TokenRefreshManager } = await import('@craft-agent/shared/sources')
  const credentials = getSourceCredentialManager()
  const refresh = new TokenRefreshManager(credentials)
  return loadWorkspaceSources(workspaceRootPath)
    .filter(source => source.config.provider === 'github' && source.config.enabled !== false && (source.config.type === 'api' || source.config.type === 'mcp'))
    .map(source => ({
      slug: source.config.slug,
      name: source.config.name,
      getToken: async () => {
        const stored = await credentials.load(source)
        if (!stored?.value) return null
        const token = stored.refreshToken ? (await refresh.ensureFreshToken(source)).token ?? null : stored.value
        // Header-map credentials (JSON) are not bearer tokens
        return token && !token.trimStart().startsWith('{') ? token : null
      },
    }))
}

export function registerPrWatchHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger
  autoFixMonitor?.dispose()
  registry?.dispose()
  let monitor: AutoFixMonitor | null = null
  const current = new PrWatchRegistry({
    associations: diskPrAssociations,
    graphql: (host, token, query, variables) => githubGraphql(host, token, query, variables),
    candidates: async (host, workspaceRootPath) => tokenCandidates(host, await loadGitHubSources(workspaceRootPath).catch(() => [])),
    push: (clientId, sessionId, state) => {
      // Auto-fix's own subscription: evaluate instead of sending anywhere
      if (clientId === AUTO_FIX_CLIENT_ID) return monitor?.onState(sessionId, state)
      pushTyped(server, RPC_CHANNELS.prWatch.CHANGED, { to: 'client', clientId }, sessionId, state)
    },
    log: message => log.info(message),
  })
  registry = current
  current.onSessionState((sessionId, state) => {
    void syncSessionTitleFromPr(deps.sessionManager, sessionId, state)
      .catch(error => log.warn?.(`[pr-title] ${sessionId}: ${error instanceof Error ? error.message : String(error)}`))
  })
  monitor = createAutoFixMonitor({
    getRegistry: () => current,
    sessionManager: deps.sessionManager,
    resolveWorkspaceRootPath,
    log: message => log.info(message),
  })
  autoFixMonitor = monitor
  const armed = monitor
  const ops = createPrWatchOps(current, deps.sessionManager, { onMonitorsChanged: sessionId => void armed.sync(sessionId) })

  // A finished turn is when pushes and `gh pr create` happen: refetch then
  deps.sessionManager.onTurnComplete?.(sessionId => {
    void current.nudge(sessionId)
  })

  // Auto-fix survives restarts: re-arm every session that has it on once sessions are loaded
  void Promise.resolve()
    .then(() => deps.sessionManager.waitForInit())
    .then(() => armed.armAll())
    .catch(error => log.warn?.(`[pr-auto-fix] re-arming at start failed: ${error instanceof Error ? error.message : String(error)}`))

  server.handle(RPC_CHANNELS.prWatch.SUBSCRIBE, async (ctx, sessionId: string): Promise<{ subscriptionId: string | null; state: PrWatchSessionState }> => {
    const session = deps.sessionManager.getSessionSnapshot(sessionId)
    if (!session) return { subscriptionId: null, state: { kind: 'unavailable', reason: 'not-git' } }
    const dir = deps.sessionManager.getSessionWorkingDirectory(sessionId) ?? session.workingDirectory
    const workspaceRootPath = resolveWorkspaceRootPath(session.workspaceId)
    if (!dir || !workspaceRootPath) return { subscriptionId: null, state: { kind: 'unavailable', reason: 'not-git' } }
    return current.subscribe({
      clientId: ctx.clientId,
      foreground: true,
      sessionId,
      dir,
      workspaceRootPath,
      boundPrs: deps.sessionManager.getSessionBoundPrs(sessionId),
      monitors: deps.sessionManager.getSessionPrMonitors(sessionId),
    })
  })

  server.handle(RPC_CHANNELS.prWatch.UNSUBSCRIBE, async (_ctx, subscriptionId: string) => {
    current.unsubscribe(subscriptionId)
  })

  server.handle(RPC_CHANNELS.prWatch.REFRESH, async (ctx, sessionId: string, automatic = false) => {
    await current.nudge(sessionId, ctx.clientId, automatic)
  })

  server.handle(RPC_CHANNELS.prWatch.GET_DETAILS, async (ctx, sessionId: string, prId: string): Promise<PrDetails | null> => {
    return current.getDetails(sessionId, prId, ctx.clientId)
  })

  server.handle(RPC_CHANNELS.prWatch.BIND, async (_ctx, sessionId: string, ref: string): Promise<PrBindToolResult> => {
    return ops.bind(sessionId, ref)
  })

  server.handle(RPC_CHANNELS.prWatch.UNBIND, async (_ctx, sessionId: string, ref: string): Promise<PrUnbindToolResult> => {
    return ops.unbind(sessionId, ref)
  })

  server.handle(RPC_CHANNELS.prWatch.SET_AUTO_MERGE, async (_ctx, sessionId: string, ref: string, enabled: boolean, method?: PrMergeMethod): Promise<PrAutoMergeToolResult> => {
    return ops.setAutoMerge(sessionId, ref, enabled, method)
  })

  server.handle(RPC_CHANNELS.prWatch.RUN_ACTION, async (ctx, sessionId: string, ref: string, request: PrQuickOperationRequest): Promise<PrQuickOperationResult> => {
    try {
      const session = deps.sessionManager.getSessionSnapshot(sessionId)
      if (!session) throw new Error('Session not found.')
      const root = resolveWorkspaceRootPath(session.workspaceId)
      if (!root || (ctx.workspaceId && resolveWorkspaceRootPath(ctx.workspaceId) !== root)) throw new Error('Session is in another workspace.')
      const state = current.cachedSessionState(sessionId)
      const entry = state?.kind === 'ready' ? state.prs.find(pr => pr.summary.url === ref) : undefined
      const coords = parsePrReference(ref)
      if (!entry || !coords) throw new Error('Refresh this session’s PR before trying again.')
      if (request?.operation === 'merge' && entry.origin !== 'branch') throw new Error('Open this PR’s own session before merging.')
      const dir = deps.sessionManager.getSessionWorkingDirectory(sessionId) ?? session.workingDirectory
      if (!dir) throw new Error('This session has no working directory.')
      const result = await current.runAction({ coords, number: coords.number, workspaceRootPath: root, dir, request })
      await current.nudge(sessionId)
      return result
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'PR action failed.' }
    }
  })

  server.handle(RPC_CHANNELS.prWatch.SET_AUTO_FIX, async (_ctx, sessionId: string, prId: string, enabled: boolean): Promise<PrAutoFixResult> => {
    return ops.setAutoFix(sessionId, prId, enabled)
  })
}
