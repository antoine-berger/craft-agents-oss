import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Spinner } from '@craft-agent/ui'
import type { RepositorySelection } from '@craft-agent/shared/protocol'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { COMPOSER_CHIP } from './composer-styles'
import { useRepoListing } from './CodingWorkspacePanel'
import { getSelectedRepositories, repositoryKey, repositoryLabel, rememberRepository, setDraftRepository } from './repository-history'
import { getPathBasename } from '@/lib/platform'
import { RepositoryAvatar, useRepositoryIdentity } from './RepositoryAvatar'

interface ComposerRepositorySelectorProps {
  workspaceId?: string
  sessionId?: string
  repository?: RepositorySelection
  repositoryPath?: string
  worktreePath?: string
  branch?: string
  disabled: boolean
  locked?: boolean
  onChoose: (repository: RepositorySelection) => void
}

export function ComposerRepositorySelector({ workspaceId, sessionId, repository, repositoryPath, worktreePath, branch, disabled, locked, onChoose }: ComposerRepositorySelectorProps) {
  const { t } = useTranslation()
  const knownNameWithOwner = repository?.nameWithOwner
  const identityPath = repository?.kind === 'local' ? repository.gitDir : repositoryPath
  const nameWithOwner = useRepositoryIdentity(knownNameWithOwner, identityPath)
  const label = nameWithOwner?.split('/').pop()
    ?? (repository ? repositoryLabel(repository).split('/').pop()!
      : repositoryPath ? getPathBasename(repositoryPath.replace(/[\\/]\.git$/, '')) : t('chat.codingMode.repos.title'))
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [history, setHistory] = React.useState(() => getSelectedRepositories(workspaceId))
  const searching = !!query.trim()
  // No scans or GitHub requests when opening the list: empty search means chosen repos only.
  const repos = useRepoListing(workspaceId, open && searching && !disabled && !locked, query.trim())
  const choices = React.useMemo(() => {
    const all: RepositorySelection[] = searching
      ? [...history, ...(repos.listing?.local ?? []), ...(repos.status === 'ready' && repos.listing?.cloneRoot ? repos.listing.github : [])] : history
    const remoteKeys = new Set((repos.status === 'ready' ? repos.listing?.github ?? [] : []).map(repositoryKey))
    const seen = new Set<string>()
    const search = query.trim().toLowerCase()
    return all.filter(repo => {
      const key = repositoryKey(repo)
      if (seen.has(key)) return false
      seen.add(key)
      return !search || `${repositoryLabel(repo)} ${repo.kind === 'local' ? repo.gitDir : ''}`.toLowerCase().includes(search)
        || (repo.kind === 'github' && remoteKeys.has(key))
    }).sort((a, b) => repositoryLabel(a).localeCompare(repositoryLabel(b)))
  }, [history, repos.listing, repos.status, query, searching])

  const choose = (repo: RepositorySelection) => {
    if (!sessionId || disabled || locked) return
    // A selection is local, synchronous draft state. Clone/worktree creation happens on send.
    rememberRepository(repo, workspaceId)
    setDraftRepository(repo, sessionId, workspaceId)
    setHistory(getSelectedRepositories(workspaceId))
    onChoose(repo)
    setOpen(false)
    setQuery('')
  }
  return (
    <Popover open={open && !disabled} onOpenChange={value => { setOpen(value); if (value) setHistory(getSelectedRepositories(workspaceId)); else setQuery('') }}>
      <PopoverTrigger asChild>
        <button type="button" className={COMPOSER_CHIP} disabled={disabled} aria-label={`${t('chat.repository.label')}: ${label}`}>
          <RepositoryAvatar nameWithOwner={nameWithOwner ?? undefined} />
          <span className="min-w-0 truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[340px] max-w-[calc(100vw-24px)] p-0">
        {locked ? (
          <div className="space-y-3 p-3 text-label">
            <p className="font-medium">{label}</p>
            {branch && <p className="break-all text-secondary">{t('chat.onBranch', { branch })}</p>}
            <dl className="space-y-2 text-label-sm">
              <div>
                <dt className="text-tertiary">{t('chat.repository.label')}</dt>
                <dd className="break-all select-text text-secondary">{repositoryPath}</dd>
              </div>
              {worktreePath && <div>
                <dt className="text-tertiary">{t('chat.workingDirectory')}</dt>
                <dd className="break-all select-text text-secondary">{worktreePath}</dd>
              </div>}
            </dl>
          </div>
        ) : (
          <Command shouldFilter={false} className="bg-transparent" label={t('chat.codingMode.repos.title')}>
            <CommandInput placeholder={t('chat.repository.searchNew')} value={query} onValueChange={setQuery} autoFocus />
            <CommandList className="max-h-[300px]">
              {searching && repos.status === 'loading' && <div className="flex items-center gap-2 px-3 py-2 text-label-sm text-tertiary"><Spinner />{t('chat.codingMode.repos.loading')}</div>}
              {searching && repos.status === 'error' && <p role="alert" className="px-3 py-2 text-label-sm text-destructive">{repos.error}</p>}
              {(!searching || repos.status !== 'loading') && <CommandEmpty>{t(searching ? 'chat.codingMode.repos.empty' : 'chat.repository.searchHint')}</CommandEmpty>}
              {searching && repos.listing?.githubUnavailable && <p className="px-3 py-2 text-label-sm text-tertiary">{t('chat.repository.remoteSearchUnavailable')}</p>}
              <CommandGroup heading={t(searching ? 'chat.repository.searchResults' : 'chat.repository.chosen')}>
                {choices.map(repo => <CommandItem key={repositoryKey(repo)} value={repositoryKey(repo)} onSelect={() => choose(repo)}>
                  <RepositoryAvatar nameWithOwner={repo.nameWithOwner} repositoryPath={repo.kind === 'local' ? repo.gitDir : undefined} />
                  <span className="truncate">{repositoryLabel(repo).split('/').pop()}</span>
                </CommandItem>)}
              </CommandGroup>
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  )
}
