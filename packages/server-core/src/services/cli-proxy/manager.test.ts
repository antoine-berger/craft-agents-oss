import { describe, expect, it, mock } from 'bun:test'
import { CliProxyManager, publicAccounts } from './manager'

describe('integrated account proxy boundaries', () => {
  it('exposes only account labels/status and strips tokens, ID claims, file paths and unrelated providers', () => {
    const result = publicAccounts([
      { name: 'account.json', type: 'claude', email: 'a@example.invalid', status: 'active', disabled: false,
        access_token: 'secret-access', refresh_token: 'secret-refresh', id_token: { private: true }, path: '/private/auth.json' },
      { name: 'other.json', type: 'gemini', access_token: 'secret-other' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]?.provider).toBe('claude')
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('/private')
    expect(JSON.stringify(result)).not.toContain('id_token')
  })

  function harness() {
    const manager = Object.create(CliProxyManager.prototype) as CliProxyManager
    const internal = manager as unknown as Record<string, any>
    internal.pending = new Map()
    internal.initialize = async () => {}
    internal.status = async () => ({ enabled: true, running: true, accounts: [], models: [] })
    internal.management = mock(async () => ({ url: 'https://claude.ai/oauth/authorize?state=bound-state', state: 'bound-state' }))
    return { manager, internal }
  }

  it('binds account sign-in to the initiating client and rejects unsolicited callbacks', async () => {
    const { manager, internal } = harness()
    await manager.command({ action: 'startOAuth', provider: 'claude' }, 'window-a')
    await expect(manager.command({ action: 'completeOAuth', state: 'bound-state', code: 'code' }, 'window-b')).rejects.toThrow('expired')
    expect(internal.management).toHaveBeenCalledTimes(1)
    await manager.command({ action: 'completeOAuth', state: 'bound-state', code: 'code' }, 'window-a')
    expect(internal.management).toHaveBeenCalledTimes(2)
  })

  it('refuses unexpected authentication destinations before exposing a URL', async () => {
    const { manager, internal } = harness()
    internal.management = async () => ({ url: 'https://attacker.invalid/login', state: 'state' })
    await expect(manager.command({ action: 'startOAuth', provider: 'claude' }, 'window-a')).rejects.toThrow('Unexpected sign-in')
    expect(internal.pending.size).toBe(0)
  })
})
