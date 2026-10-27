import { useEffect, useState } from 'react'
import type { WorkspaceAttention } from '@craft-agent/shared/protocol'

/** One workspace snapshot; never start a PR watcher per row or clear reasons on read. */
export function useSessionAttention(workspaceId: string | undefined): WorkspaceAttention | null {
  const [snapshot, setSnapshot] = useState<WorkspaceAttention | null>(null)
  useEffect(() => {
    setSnapshot(null)
    if (!workspaceId || !window.electronAPI?.getSessionAttention) return
    let stopped = false
    const apply = (next: WorkspaceAttention) => {
      if (stopped || next.workspaceId !== workspaceId) return
      setSnapshot(old => !old || old.workspaceId !== workspaceId || next.revision >= old.revision ? next : old)
    }
    const off = window.electronAPI.onSessionAttentionChanged(apply)
    void window.electronAPI.getSessionAttention(workspaceId).then(apply, () => {})
    return () => { stopped = true; off() }
  }, [workspaceId])
  return snapshot?.workspaceId === workspaceId ? snapshot : null
}
