import { useTranslation } from 'react-i18next'
import type { LoadedSource } from '../../../shared/types'

/** Native account connectors are managed by Claude, not by Craft's source picker. */
export function ClaudeConnectorsNotice({ connectors = [] }: { connectors?: LoadedSource[] }) {
  const { t } = useTranslation()
  return (
    <div className="px-3 py-2 text-label-sm text-secondary">
      <p>{t('chat.claudeConnectors.managedHint')}</p>
      {connectors.length > 0 && (
        <ul className="mt-2 max-h-56 space-y-2 overflow-y-auto">
          {connectors.map(source => <li key={source.config.slug} className="flex items-start justify-between gap-3">
            <span className="text-foreground">{source.config.name}</span>
            <span className={source.config.connectionStatus === 'connected' ? 'text-success' : 'text-tertiary'}>
              {t(source.config.connectionStatus === 'connected' ? 'sourcesList.statusConnected'
                : source.config.connectionStatus === 'needs_auth' ? 'sourcesList.statusAuthRequired'
                : source.config.connectionStatus === 'untested' ? 'sourcesList.statusNotTested' : 'sourcesList.statusDisconnected')}
            </span>
          </li>)}
        </ul>
      )}
      <button
        type="button"
        className="mt-1 text-foreground underline underline-offset-2 hover:opacity-80"
        onClick={() => window.electronAPI.openUrl('https://claude.ai/customize/connectors')}
      >
        {t('chat.claudeConnectors.manage')}
      </button>
    </div>
  )
}
