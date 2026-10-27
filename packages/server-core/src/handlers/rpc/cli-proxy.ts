import { getWorkspaces } from '@craft-agent/shared/config'
import { loadClaudeConnectorSources } from '../../services/claude-connectors'
import { clearProxyConnectorCache } from '../../services/cli-proxy/connectors'
import { RPC_CHANNELS, type CliProxyCommand, type CliProxyImportAccount } from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { getCliProxyManager } from '../../services/cli-proxy/manager'

export const HANDLED_CHANNELS = [RPC_CHANNELS.cliProxy.STATUS, RPC_CHANNELS.cliProxy.COMMAND, RPC_CHANNELS.cliProxy.IMPORT_ACCOUNTS] as const

export function registerCliProxyHandlers(server: RpcServer, deps: HandlerDeps): void {
  const manager = getCliProxyManager()
  if (process.env.NODE_ENV !== 'test') void manager.resume().catch(() => deps.platform.logger.warn('Integrated account service could not resume'))
  const changed = () => server.push(RPC_CHANNELS.llmConnections.CHANGED, { to: 'all' }, null)
  server.handle(RPC_CHANNELS.cliProxy.STATUS, () => manager.status())
  server.handle(RPC_CHANNELS.cliProxy.COMMAND, async (context, command: CliProxyCommand) => {
    if (!command || typeof command.action !== 'string') throw new Error('Invalid account action')
    const result = await manager.command(command, context.clientId)
    if (['importCraft', 'syncModels', 'setAccountEnabled', 'oauthStatus', 'routeAll', 'setConnectorAccount'].includes(command.action)) changed()
    if (['routeAll', 'setConnectorAccount', 'setAccountEnabled'].includes(command.action) && result.status.routingAll) {
      clearProxyConnectorCache()
      if (command.action === 'routeAll') await deps.sessionManager.reinitializeAuth()
      for (const workspace of getWorkspaces()) {
        const sources = await loadClaudeConnectorSources(workspace)
        const { loadWorkspaceSources } = await import('@craft-agent/shared/sources')
        server.push(RPC_CHANNELS.sources.CHANGED, { to: 'workspace', workspaceId: workspace.id }, workspace.id, [...sources, ...loadWorkspaceSources(workspace.rootPath)])
      }
    }
    return result
  })
  server.handle(RPC_CHANNELS.cliProxy.IMPORT_ACCOUNTS, async (_context, accounts: CliProxyImportAccount[]) => {
    const imported = await manager.importAccounts(accounts)
    changed()
    return { imported, status: await manager.status() }
  })
}
