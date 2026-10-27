import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { CliProxyCommand, CliProxyProvider, CliProxyStatus } from '@craft-agent/shared/protocol'
import { SettingsCard, SettingsRow, SettingsSection, SettingsToggle } from '@/components/settings'
import { Button } from '@/components/ui/button'
import { Spinner } from '@craft-agent/ui'

export function AccountPoolSection() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<CliProxyStatus>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const desktop = window.electronAPI.getRuntimeEnvironment?.() === 'electron'
  const refresh = useCallback(async () => {
    try { setStatus(await window.electronAPI.getCliProxyStatus()) }
    catch { setError(t('settings.accountPool.unavailable')) }
  }, [t])
  useEffect(() => {
    let active = true
    const load = async () => {
      try { const next = await window.electronAPI.getCliProxyStatus(); if (active) setStatus(next) }
      catch { if (active) setError(t('settings.accountPool.unavailable')) }
    }
    void load()
    const timer = setInterval(load, 3000)
    return () => { active = false; clearInterval(timer) }
  }, [t])

  const run = async (key: string, action: () => Promise<void>) => {
    if (busy) return
    setBusy(key); setError(undefined)
    try { await action(); await refresh() }
    catch (error) { setError(error instanceof Error ? error.message : t('settings.accountPool.failed')) }
    finally { setBusy(undefined) }
  }
  const command = (input: CliProxyCommand) => window.electronAPI.cliProxyCommand(input).then(result => { setStatus(result.status) })
  const signIn = (provider: CliProxyProvider) => run(provider, async () => {
    const result = await window.electronAPI.connectCliProxyAccount(provider)
    if (!result.success) throw new Error(result.error || t('settings.accountPool.failed'))
    toast.success(t('settings.accountPool.connected'))
  })
  const importing = () => run('import', async () => {
    const server = await window.electronAPI.cliProxyCommand({ action: 'importCraft' })
    const local = desktop ? await window.electronAPI.importLocalCliProxyAccounts() : undefined
    await command({ action: 'syncModels' })
    toast.success(t('settings.accountPool.imported', { count: (server.imported ?? 0) + (local?.imported ?? 0) }))
  })

  return (
    <SettingsSection title={t('settings.accountPool.title')} description={t('settings.accountPool.description')}>
      <SettingsCard>
        <SettingsRow label={t('settings.accountPool.service')}
          description={status?.phase === 'starting' ? t('settings.accountPool.starting') : status?.running ? t('settings.accountPool.running') : t('settings.accountPool.stopped')}>
          <Button variant="secondary" disabled={!!busy || status?.phase === 'starting'}
            onClick={() => void run('service', () => command({ action: status?.running ? 'disable' : 'enable' }))}>
            {status?.phase === 'starting' && <Spinner />}
            {t(status?.running ? 'settings.accountPool.disable' : 'settings.accountPool.enable')}
          </Button>
        </SettingsRow>
        {status?.running && (
          <div className="flex flex-wrap gap-2 px-3.5 py-3">
            <Button variant="secondary" disabled={!!busy || !desktop} onClick={() => void signIn('claude')}>{t('settings.accountPool.addClaude')}</Button>
            <Button variant="secondary" disabled={!!busy || !desktop} onClick={() => void signIn('codex')}>{t('settings.accountPool.addGpt')}</Button>
            <Button variant="secondary" disabled={!!busy} onClick={importing}>{t('settings.accountPool.import')}</Button>
            <Button variant="ghost" disabled={!!busy} onClick={() => void run('refresh', () => command({ action: 'syncModels' }))}>{t('common.refresh')}</Button>
          </div>
        )}
        {status?.running && (
          <SettingsRow label={t('settings.accountPool.routing')} description={t(status.routingAll ? 'settings.accountPool.allRouted' : 'settings.accountPool.optInRouting')}>
            {!status.routingAll && <Button variant="secondary" disabled={!!busy} onClick={() => void run('routing', () => command({ action: 'routeAll' }))}>{t('settings.accountPool.routeAll')}</Button>}
          </SettingsRow>
        )}
        {status?.routingAll && (
          <SettingsRow label={t('settings.accountPool.mcpAccount')} description={t('settings.accountPool.mcpAccountHint')}>
            <select className="max-w-64 rounded-lg bg-background px-2 py-1.5 text-label-sm" aria-label={t('settings.accountPool.mcpAccount')}
              disabled={!!busy || !status.running} value={status.connectorAccountId ?? ''}
              onChange={event => void run('mcp-account', () => command({ action: 'setConnectorAccount', id: event.target.value }))}>
              {status.accounts.filter(account => account.provider === 'claude').map(account => <option key={account.id} value={account.id} disabled={account.disabled}>{account.email ?? account.name}</option>)}
            </select>
          </SettingsRow>
        )}
        {busy && (
          <SettingsRow label={t(busy === 'claude' || busy === 'codex' ? 'settings.accountPool.finishSignIn' : 'settings.accountPool.working')}>
            <Spinner />
            {(busy === 'claude' || busy === 'codex') && <Button variant="ghost" onClick={() => window.electronAPI.cancelCliProxySignIn()}>{t('common.cancel')}</Button>}
          </SettingsRow>
        )}
        {status?.accounts.map(account => (
          <SettingsToggle key={account.id} label={account.email || account.name}
            description={`${account.provider === 'claude' ? 'Claude' : 'GPT'} · ${account.status}`}
            checked={!account.disabled} disabled={!!busy || !status.running}
            onCheckedChange={enabled => void run(account.id, () => command({ action: 'setAccountEnabled', id: account.id, enabled }))} />
        ))}
        {(error || status?.error) && <p role="alert" className="px-3.5 py-3 text-label-sm text-destructive">{error || status?.error}</p>}
      </SettingsCard>
      <p className="text-label-sm text-tertiary">{t(status?.routingAll ? 'settings.accountPool.allMcp' : 'settings.accountPool.nativeMcp')}</p>
      {!desktop && <p className="text-label-sm text-secondary">{t('settings.accountPool.desktopSignIn')}</p>}
    </SettingsSection>
  )
}
