import type { RpcServer } from '@craft-agent/server-core/transport'
import type { ConductorListOptions, ConductorExportOptions } from '../../../../../packages/shared/src/protocol/conductor-import'
import { listLocalConductorChats, exportLocalConductorChat } from '../conductor-reader'

export const GUI_HANDLED_CHANNELS = ['conductor:listLocal', 'conductor:exportLocal'] as const
/** These two handlers must stay on the desktop even while the workspace runs remotely. */
export function registerConductorLocalHandlers(server: RpcServer): void {
  server.handle('conductor:listLocal', (_ctx, options?: ConductorListOptions) => listLocalConductorChats(options))
  server.handle('conductor:exportLocal', (_ctx, sessionId: string, options?: ConductorExportOptions) => exportLocalConductorChat(sessionId, options))
}
