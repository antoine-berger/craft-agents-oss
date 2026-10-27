import { useTranslation } from 'react-i18next'
import type { LoadedSource } from '../../../shared/types'
import { SourceAvatar } from '@/components/ui/source-avatar'
import { Button } from '@/components/ui/button'
import { Info_Page, Info_Section, Info_StatePill, ToolsDataTable } from '@/components/info'

export function ClaudeAccountSourceInfo({ source }: { source: LoadedSource }) {
  const { t } = useTranslation()
  const connected = source.config.connectionStatus === 'connected'
  const status = connected ? 'sourcesList.statusConnected'
    : source.config.connectionStatus === 'needs_auth' ? 'sourcesList.statusAuthRequired'
    : source.config.connectionStatus === 'untested' ? 'sourcesList.statusNotTested' : 'sourcesList.statusDisconnected'
  return (
    <Info_Page>
      <Info_Page.Header />
      <Info_Page.Content>
        <Info_Page.Hero avatar={<SourceAvatar source={source} fluid />} title={source.config.name}
          tagline={source.config.tagline}
          meta={<Info_StatePill tone={connected ? 'ok' : 'warn'}>{t(status)}</Info_StatePill>} />
        <Info_Section title={t('sourceInfo.connection')} description={t(source.claudeAccount?.proxy ? 'settings.accountPool.allMcp' : 'chat.claudeConnectors.managedHint')}>
          <Button variant="secondary" onClick={() => window.electronAPI.openUrl('https://claude.ai/customize/connectors')}>
            {t('chat.claudeConnectors.manage')}
          </Button>
        </Info_Section>
        <Info_Section title={t('sourceInfo.tools')} count={source.claudeAccount?.tools.length ?? 0}>
          <ToolsDataTable showPermissions={false} data={(source.claudeAccount?.tools ?? []).map(tool => ({
            name: tool.name, description: tool.description ?? '', permission: 'requires-permission',
          }))} />
        </Info_Section>
      </Info_Page.Content>
    </Info_Page>
  )
}
