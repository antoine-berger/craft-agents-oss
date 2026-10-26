import { useTranslation } from 'react-i18next'

/** Native account connectors are managed by Claude, not by Craft's source picker. */
export function ClaudeConnectorsNotice() {
  const { t } = useTranslation()
  return (
    <div className="px-3 py-2 text-label-sm text-secondary">
      <p>{t('chat.claudeConnectors.managedHint')}</p>
      <button
        type="button"
        className="mt-1 text-foreground underline underline-offset-2 hover:opacity-80"
        onClick={() => window.electronAPI.openUrl('https://claude.ai')}
      >
        {t('chat.claudeConnectors.manage')}
      </button>
    </div>
  )
}
