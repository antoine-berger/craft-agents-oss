/** A read-only branch/worktree review. Paths are relative to the source repository. */
export interface GitReviewLine {
  kind: 'context' | 'add' | 'remove' | 'hunk' | 'meta'
  text: string
  oldLine?: number
  newLine?: number
}
export interface GitReviewFile {
  path: string
  previousPath?: string
  status: string
  untracked: boolean
  binary: boolean
  lines: GitReviewLine[]
  truncated: boolean
  notice?: string
}
export interface GitReviewSnapshot {
  repositoryPath: string
  branch: string
  baseRef: string
  baseCommit: string
  headCommit: string
  generatedAt: number
  files: GitReviewFile[]
  truncated: boolean
  omittedFiles: number
}
export interface GitReviewComment {
  path: string
  side: 'old' | 'new'
  line: number
  excerpt: string
  text: string
}

/** Comments become a user-reviewed draft, never an automatic message or GitHub publication. */
export function formatGitReviewComments(snapshot: GitReviewSnapshot, comments: GitReviewComment[]): string {
  const items = comments.map(comment => {
    const location = `${JSON.stringify(comment.path)}:${comment.line} (${comment.side})`
    const excerpt = comment.excerpt.slice(0, 500).replace(/\r?\n/g, ' ')
    return `- ${location}: ${comment.text.trim()}\n  Code: ${JSON.stringify(excerpt)}`
  })
  return `Please address these review comments on branch ${JSON.stringify(snapshot.branch)} (HEAD ${snapshot.headCommit.slice(0, 12)}, compared with ${JSON.stringify(snapshot.baseRef)}). The line numbers refer to the reviewed snapshot; locate the quoted code if the worktree changed.\n\n${items.join('\n\n')}`
}
