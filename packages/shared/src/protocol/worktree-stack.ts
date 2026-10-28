export const WORKTREE_STACK_CHANNELS = { GET: 'worktreeStack:get' } as const

export type WorktreeStackState = 'up-to-date' | 'needs-restack' | 'diverged' | 'missing-parent' | 'parent-switched' | 'ambiguous' | 'unknown' | 'cycle'

export interface WorktreeStackSession {
  sessionId: string
  title: string
  branch?: string
  archived: boolean
}

export interface WorktreeStackSnapshot {
  sessionId: string
  status: 'ready' | 'none' | 'unavailable'
  reason?: string
  branch?: string
  parent?: {
    branch: string
    baseCommit: string
    currentCommit?: string
    session?: WorktreeStackSession
    state: WorktreeStackState
    detail: string
    /** Current cached PR evidence only; no GitHub request is made by this API. */
    merged?: boolean
  }
  children: WorktreeStackSession[]
  observedAt: number
}

export interface WorktreeStackAPI {
  getSessionStack(sessionId: string): Promise<WorktreeStackSnapshot>
}
