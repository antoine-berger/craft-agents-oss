/** Paths are relative to the session's actual Git worktree, never its history directory. */
export const WORKTREE_FILES_CHANNELS = {
  LIST: 'worktreeFiles:list',
  READ: 'worktreeFiles:read',
  WRITE: 'worktreeFiles:write',
} as const

export interface WorktreeFileEntry {
  name: string
  path: string
  kind: 'directory' | 'file' | 'symlink'
}

export interface WorktreeDirectory {
  rootName: string
  path: string
  entries: WorktreeFileEntry[]
  truncated: boolean
}

export interface WorktreeTextFile {
  path: string
  content: string
  /** Opaque version checked before saving; refresh after an external edit. */
  version: string
  modifiedAt: number
}

export interface WorktreeFileWrite {
  path: string
  content: string
  expectedVersion: string
}

export interface WorktreeFilesAPI {
  getWorktreeFiles(sessionId: string, path?: string): Promise<WorktreeDirectory>
  readWorktreeFile(sessionId: string, path: string): Promise<WorktreeTextFile>
  writeWorktreeFile(sessionId: string, input: WorktreeFileWrite): Promise<WorktreeTextFile>
}
