import * as React from 'react'
import type { RepoListing } from '@craft-agent/shared/protocol'
import { getRecentWorkingDirs } from './working-directory-history'

export function useRepoListing(workspaceId: string | undefined, active: boolean, query?: string) {
  const [state, setState] = React.useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; listing?: RepoListing; error?: string }>({ status: 'idle' })
  React.useEffect(() => {
    if (!active || !workspaceId || !window.electronAPI?.listRepositories) return
    let cancelled = false
    setState(current => ({ ...current, status: 'loading' }))
    const timer = setTimeout(() => window.electronAPI.listRepositories(workspaceId, getRecentWorkingDirs(workspaceId), query ? { query } : undefined).then(
      (listing) => {
        if (!cancelled) setState({ status: 'ready', listing })
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      },
    ), query ? 200 : 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [active, workspaceId, query])
  return state
}
