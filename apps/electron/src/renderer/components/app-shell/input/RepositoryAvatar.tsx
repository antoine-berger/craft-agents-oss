import * as React from 'react'
import { FolderGit2 } from 'lucide-react'

/** Resolve only the chosen/remembered repository; never scan or block selection. */
export function useRepositoryIdentity(knownNameWithOwner?: string, repositoryPath?: string) {
  const [resolved, setResolved] = React.useState<{ path: string; nameWithOwner: string | null }>()
  React.useEffect(() => {
    if (knownNameWithOwner || !repositoryPath || !window.electronAPI?.getRepositoryIdentity) return
    let cancelled = false
    window.electronAPI.getRepositoryIdentity(repositoryPath).then(nameWithOwner => {
      if (!cancelled) setResolved({ path: repositoryPath, nameWithOwner })
    }).catch(() => { /* Keep the local folder presentation when unavailable. */ })
    return () => { cancelled = true }
  }, [knownNameWithOwner, repositoryPath])
  return knownNameWithOwner ?? (resolved?.path === repositoryPath ? resolved?.nameWithOwner : undefined) ?? undefined
}

/** The organization/user avatar, shared by the selected repository and its menu rows. */
export function RepositoryAvatar({ nameWithOwner, repositoryPath }: { nameWithOwner?: string; repositoryPath?: string }) {
  const identity = useRepositoryIdentity(nameWithOwner, repositoryPath)
  const owner = identity?.split('/')[0]
  const [failedOwner, setFailedOwner] = React.useState<string>()
  if (!owner) return <FolderGit2 className="size-4 shrink-0 text-tertiary" aria-hidden="true" />
  if (failedOwner === owner) return <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center rounded-sm bg-foreground/10 text-[10px] font-medium">{owner[0]?.toUpperCase()}</span>
  return <img src={`https://github.com/${encodeURIComponent(owner)}.png?size=64`} alt="" aria-hidden="true"
    className="size-4 shrink-0 rounded-sm object-contain" referrerPolicy="no-referrer" onError={() => setFailedOwner(owner)} />
}
