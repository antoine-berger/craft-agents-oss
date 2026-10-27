import { describe, expect, it, mock } from 'bun:test'
import { CliProxyManager } from './manager'

describe('credential-bound quota relay', () => {
  it('uses only fixed GET endpoints with server-side credential substitution', async () => {
    const manager = Object.create(CliProxyManager.prototype) as CliProxyManager
    const internal = manager as unknown as Record<string, any>
    internal.initialize = async () => {}
    internal.phase = 'running'
    internal.management = async () => ({ files: [
      { name: 'claude-a', type: 'claude', auth_index: 'private-a' },
      { name: 'gpt-b', type: 'codex', auth_index: 'private-b', id_token: { chatgpt_account_id: 'account-b' } },
      { name: 'disabled', type: 'claude', auth_index: 'private-c', disabled: true },
    ] })
    internal.request = mock(async () => ({ status_code: 200, header: {}, body: '{}' }))
    await manager.relayQuota('claude-a')
    await manager.relayQuota('gpt-b')
    for (const args of internal.request.mock.calls) {
      expect(args[0]).toBe('/requests/api-call')
      expect(args[1]).toBe(true)
      expect(args[2]).toBe('POST')
      expect(args[3].method).toBe('GET')
      expect(args[3].header.Authorization).toBe('Bearer $TOKEN$')
      expect(args[3].data).toBeUndefined()
    }
    expect(internal.request.mock.calls[0][3].url).toBe('https://api.anthropic.com/api/oauth/usage')
    expect(internal.request.mock.calls[1][3].url).toBe('https://chatgpt.com/backend-api/wham/usage')
    expect(internal.request.mock.calls[1][3].header['Chatgpt-Account-Id']).toBe('account-b')
    await expect(manager.relayQuota('https://attacker.invalid')).rejects.toThrow('unavailable')
    await expect(manager.relayQuota('disabled')).rejects.toThrow('unavailable')
    expect(internal.request).toHaveBeenCalledTimes(2)
  })
})
