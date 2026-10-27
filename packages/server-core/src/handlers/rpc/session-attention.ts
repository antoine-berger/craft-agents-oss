import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { SESSION_ATTENTION_CHANNELS } from '../../../../shared/src/protocol/session-attention'
import type { HandlerDeps } from '../handler-deps'
import { type RpcServer } from '../../transport'
import { SessionAttentionService } from '../../services/session-attention/service'

export const HANDLED_CHANNELS = [SESSION_ATTENTION_CHANNELS.GET] as const
let service: SessionAttentionService | null = null
export function getSessionAttentionService(): SessionAttentionService | null { return service }
export function disposeSessionAttention(): void { service?.dispose(); service = null }
export function registerSessionAttentionHandlers(server: RpcServer, deps: HandlerDeps): void {
  disposeSessionAttention()
  service = new SessionAttentionService({ manager: deps.sessionManager,
    workspaceRoot: id => getWorkspaceByNameOrId(id)?.rootPath ?? null,
    push: snapshot => server.push(SESSION_ATTENTION_CHANNELS.CHANGED, { to: 'workspace', workspaceId: snapshot.workspaceId }, snapshot),
    log: error => deps.platform.logger.warn?.(`[attention] ${error instanceof Error ? error.message : String(error)}`),
  })
  server.handle(SESSION_ATTENTION_CHANNELS.GET, (ctx, workspaceId: string) => {
    if (typeof workspaceId !== 'string' || !workspaceId || (ctx.workspaceId && ctx.workspaceId !== workspaceId)) throw new Error('Invalid attention workspace')
    return service!.snapshot(workspaceId)
  })
}
