import { describe, expect, it, mock } from 'bun:test'
import type { RpcServer } from '../../../transport'
import { registerProviderQuotaHandlers } from '../provider-quotas'
import { ProviderQuotaService } from '../../../services/provider-quotas'
import { PROVIDER_QUOTA_CHANNELS } from '../../../../../shared/src/protocol/provider-quotas'

describe('provider quota RPC boundary', () => {
  it('accepts only a read request and cannot relay arbitrary destinations or credential headers', async () => {
    let handle!: (...args: any[]) => any
    const server = { handle: (channel: string, fn: (...args: any[]) => any) => { expect(channel).toBe(PROVIDER_QUOTA_CHANNELS.GET); handle = fn } } as unknown as RpcServer
    const service = Object.create(ProviderQuotaService.prototype) as ProviderQuotaService
    service.get = mock(async () => ({ accounts: [], generatedAt: 1, serviceAvailable: true }))
    registerProviderQuotaHandlers(server, service)
    for (const request of [null, [], { refresh: 'true' }, { accountId: 5 }, { accountId: 'x'.repeat(301) }]) {
      expect(() => handle({}, request)).toThrow('Invalid quota request')
    }
    await handle({}, { refresh: false, accountId: 'account-a', url: 'https://attacker.invalid', header: { Authorization: 'private' } })
    expect(service.get).toHaveBeenCalledWith({ refresh: false, accountId: 'account-a' })
  })
})
