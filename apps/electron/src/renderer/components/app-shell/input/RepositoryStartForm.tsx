import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranch, X } from 'lucide-react'
import { parseRepositoryStart, type RepositorySelection, type RepositoryStart } from '@craft-agent/shared/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

function referenceLabel(start?: RepositoryStart): string {
  if (!start) return ''
  if (start.kind === 'branch') return `branch:${start.branch}`
  if (start.kind === 'linear-issue') return start.url ?? start.identifier
  if (start.repository) return `https://github.com/${start.repository}/${start.kind === 'pull-request' ? 'pull' : 'issues'}/${start.number}`
  return `${start.kind === 'pull-request' ? 'pr:' : '#'}${start.number}`
}

/** Optional context never performs Git or network work while selecting a repository. */
export function RepositoryStartForm({ repository, disabled, onChoose }: { repository?: RepositorySelection; disabled: boolean; onChoose: (repository: RepositorySelection) => void }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = React.useState(!!repository?.start)
  const [reference, setReference] = React.useState(referenceLabel(repository?.start))
  const [copy, setCopy] = React.useState(!!(repository?.start && 'copy' in repository.start && repository.start.copy))
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    setReference(referenceLabel(repository?.start))
    setCopy(!!(repository?.start && 'copy' in repository.start && repository.start.copy))
    setError('')
  }, [repository])
  const kind = React.useMemo(() => { try { return parseRepositoryStart(reference).kind } catch { return undefined } }, [reference])
  if (!repository) return null
  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    try {
      const start = parseRepositoryStart(reference)
      onChoose({ ...repository, start: start.kind === 'branch' || start.kind === 'pull-request' ? { ...start, copy } : start })
    } catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)) }
  }
  return <div className="border-t border-border/50 p-2">
    <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-label-sm text-secondary hover:bg-foreground/5" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
      <GitBranch className="size-3.5" />{t('chat.repository.startFrom', { defaultValue: 'Start from a branch, PR or issue' })}
    </button>
    {expanded && <form onSubmit={submit} className="space-y-2 px-2 pb-1 pt-2">
      <Input aria-label={t('chat.repository.startReference', { defaultValue: 'Starting reference' })} placeholder="branch:name · pr:123 · #123 · Linear URL" value={reference} onChange={event => { setReference(event.target.value); setError('') }} disabled={disabled} />
      {(kind === 'branch' || kind === 'pull-request') && <label className="flex items-start gap-2 text-label-sm text-secondary"><input type="checkbox" checked={copy} onChange={event => setCopy(event.target.checked)} className="mt-0.5" />{t('chat.repository.startCopy', { defaultValue: 'Create a new branch copy instead of continuing the selected branch or PR' })}</label>}
      <p className="text-caption text-tertiary">{t('chat.repository.startDeferred', { defaultValue: 'Resolved when you send. An existing branch must be free in other workspaces.' })}</p>
      {error && <p role="alert" className="text-label-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        {repository.start && <Button type="button" variant="ghost" size="sm" onClick={() => { const { start: _start, ...base } = repository; onChoose(base) }}><X className="size-3" />{t('common.clear', { defaultValue: 'Clear' })}</Button>}
        <Button type="submit" size="sm" disabled={disabled || !reference.trim()}>{t('common.apply', { defaultValue: 'Apply' })}</Button>
      </div>
    </form>}
  </div>
}
