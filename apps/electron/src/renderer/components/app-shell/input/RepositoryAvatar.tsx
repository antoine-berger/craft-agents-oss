import * as React from 'react'
import { FolderGit2 } from 'lucide-react'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import type { Session } from '@craft-agent/shared/protocol'

/** Display metadata remains valid even when an imported checkout is unavailable. */
export function sessionRepositoryIdentity(session: Pick<Session, 'worktree' | 'importedFrom' | 'boundPrs'>): string | undefined {
  const valid = (value?: string) => value && /^[\w.-]+\/[\w.-]+$/.test(value) ? value : undefined
  const known = valid(session.worktree?.pendingRepository?.nameWithOwner) ?? valid(session.importedFrom?.repository)
  if (known) return known
  const repositories = new Set((session.boundPrs ?? [])
    .filter(pr => pr.host.toLowerCase() === 'github.com')
    .map(pr => valid(`${pr.owner}/${pr.repo}`)).filter((name): name is string => !!name))
  return repositories.size === 1 ? repositories.values().next().value : undefined
}

const pendingIdentities = new Map<string, Promise<string | null>>()

/** Share simultaneous lookups, but never keep a failed/unknown result cached. */
export function resolveRepositoryIdentity(key: string, load: () => Promise<string | null>): Promise<string | null> {
  const pending = pendingIdentities.get(key)
  if (pending) return pending
  const request = Promise.resolve().then(load).finally(() => pendingIdentities.delete(key))
  pendingIdentities.set(key, request)
  return request
}

/** Resolve only the chosen/remembered repository; never scan or block selection. */
export function useRepositoryIdentity(knownNameWithOwner?: string, repositoryPath?: string) {
  const workspaceId = useOptionalAppShellContext()?.activeWorkspaceId
  const lookupKey = `${workspaceId ?? ''}\0${repositoryPath ?? ''}`
  const [resolved, setResolved] = React.useState<{ key: string; nameWithOwner: string | null }>()
  React.useEffect(() => {
    if (knownNameWithOwner || !repositoryPath || !window.electronAPI?.getRepositoryIdentity) return
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const resolve = async (attempt = 0) => {
      try {
        const nameWithOwner = await resolveRepositoryIdentity(lookupKey,
          () => window.electronAPI.getRepositoryIdentity(repositoryPath))
        if (cancelled) return
        if (nameWithOwner) { setResolved({ key: lookupKey, nameWithOwner }); return }
      } catch { /* A reconnect can temporarily interrupt the lookup. */ }
      if (!cancelled && attempt < 2) retry = setTimeout(() => { void resolve(attempt + 1) }, 1000 * (attempt + 1))
    }
    void resolve()
    const unsubscribe = window.electronAPI.onTransportConnectionStateChanged?.(state => {
      if (state.status === 'connected') { clearTimeout(retry); void resolve() }
    })
    return () => { cancelled = true; clearTimeout(retry); unsubscribe?.() }
  }, [knownNameWithOwner, repositoryPath, lookupKey])
  return knownNameWithOwner ?? (resolved?.key === lookupKey ? resolved?.nameWithOwner : undefined) ?? undefined
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
