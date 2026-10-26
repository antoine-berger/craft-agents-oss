import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { FolderGit2 } from 'lucide-react'
import { Spinner } from '@craft-agent/ui'
import type { GitHubRepo, LocalRepo } from '@craft-agent/shared/protocol'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { COMPOSER_CHIP } from './composer-styles'
import { defaultWorktreeBranch, RepoPicker, useRepoListing } from './CodingWorkspacePanel'
import { getRecentWorkingDirs } from './working-directory-history'
import { getPathBasename } from '@/lib/platform'

interface ComposerRepositorySelectorProps {
  workspaceId?: string
  sessionId?: string
  configured: boolean
  repositoryPath?: string
  disabled: boolean
  onReady: (path: string) => void
}

export function ComposerRepositorySelector({ workspaceId, sessionId, configured, repositoryPath, disabled, onReady }: ComposerRepositorySelectorProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(!configured)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [selectedName, setSelectedName] = React.useState<string>()
  const repos = useRepoListing(workspaceId, open && !configured && !disabled)

  const chooseRepository = async (repo: LocalRepo | GitHubRepo) => {
    if (!workspaceId || !sessionId || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await window.electronAPI.createCodingWorktree(workspaceId, {
        sessionId, branch: defaultWorktreeBranch(sessionId),
        ...(repo.kind === 'local' ? { gitDir: repo.gitDir } : { cloneNameWithOwner: repo.nameWithOwner }),
      }, getRecentWorkingDirs(workspaceId))
      setSelectedName(repo.kind === 'local' ? repo.name : repo.nameWithOwner)
      onReady(result.path)
      setOpen(false)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally { setBusy(false) }
  }

  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={COMPOSER_CHIP} disabled={disabled}
          aria-label={t('chat.repository.label')}>
          <FolderGit2 className="size-4 shrink-0" />
          <span>{selectedName ?? (repositoryPath ? getPathBasename(repositoryPath) : t('chat.codingMode.repos.title'))}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[340px] max-w-[calc(100vw-24px)] p-0">
        {configured ? <p className="p-3 text-label text-secondary">{selectedName ?? repositoryPath}</p> : (
          <>
            <p className="border-b border-separator p-3 text-label text-secondary">{t('chat.codingMode.repos.title')}</p>
            {busy ? <div className="flex items-center gap-2 p-4"><Spinner />{t('chat.repository.preparing')}</div>
              : <RepoPicker state={repos} onPick={chooseRepository} />}
            {error && <p role="alert" className="p-3 text-label-sm text-destructive">{error}</p>}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
