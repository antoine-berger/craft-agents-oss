import type { RpcServer } from '../../transport'
import { PROVIDER_QUOTA_CHANNELS, type ProviderQuotasRequest } from '../../../../shared/src/protocol/provider-quotas'
import { getCliProxyManager } from '../../services/cli-proxy/manager'
import { ProviderQuotaService } from '../../services/provider-quotas'

export const HANDLED_CHANNELS = [PROVIDER_QUOTA_CHANNELS.GET] as const

/** Share a demand-driven cache across windows, not one polling loop per renderer. */
export function registerProviderQuotaHandlers(server: RpcServer, service = new ProviderQuotaService(getCliProxyManager())): void {
  server.handle(PROVIDER_QUOTA_CHANNELS.GET, (_context, request: ProviderQuotasRequest = {}) => {
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || (request.refresh !== undefined && typeof request.refresh !== 'boolean')
      || (request.accountId !== undefined && (typeof request.accountId !== 'string' || request.accountId.length > 300))) throw new Error('Invalid quota request')
    return service.get({ refresh: request.refresh === true, accountId: request.accountId })
  })
}
