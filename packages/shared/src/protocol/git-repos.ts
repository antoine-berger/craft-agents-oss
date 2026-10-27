/**
 * Coding mode's "Create new worktree": the repositories a new session can start a worktree from,
 * and the request/result of creating one. Pure types, safe to import from the renderer.
 *
 * Server: packages/server-core/src/services/coding-repos/ (RPCs `git:listRepos`, `git:createWorktree`).
 */

/** A repository on the workspace server's disk; its worktrees are grouped into one entry. */
export interface LocalRepo {
  kind: 'local'
  /** Display name: the GitHub repo name when the origin is on a git host, else the folder name */
  name: string
  /** `owner/repo` of the origin remote, when it is a recognizable git host URL */
  nameWithOwner?: string
  /** Shared git dir (`.git` or a bare repo): identifies the repository */
  gitDir: string
  /** Folder new worktrees are created next to */
  worktreeParent: string
  /** Number of checked-out worktrees (1 for a plain clone) */
  worktrees: number
  /** Why it is listed: one of the recently used folders, or found by the scan of the workspace folder and the folders holding recent repos (`workspace`) */
  origin: 'workspace' | 'recent'
}

/** A repository the GitHub CLI lists for the signed-in user that is not on this machine yet. */
export interface GitHubRepo {
  kind: 'github'
  nameWithOwner: string
  description?: string
  isPrivate: boolean
  /** Epoch ms */
  updatedAt?: number
}

export interface RepoListing {
  local: LocalRepo[]
  github: GitHubRepo[]
  /** Where a GitHub repo is cloned before its worktree is created (shown in the picker) */
  cloneRoot: string | null
  /** `gh` is missing or not signed in (the GitHub section explains instead of listing) */
  githubUnavailable?: 'not-installed' | 'not-signed-in'
}

/** A draft choice, not a prepared checkout. Git work begins only on first send. */
export type RepositorySelection =
  | { kind: 'local'; gitDir: string; name: string; nameWithOwner?: string; start?: RepositoryStart }
  | { kind: 'github'; nameWithOwner: string; start?: RepositoryStart };

export interface CreateWorktreeRequest {
  /** Bind and persist an isolated worktree owned by this new session. */
  sessionId?: string
  /** A local repository (its `gitDir`) … */
  gitDir?: string
  /** … or a GitHub repository to clone first */
  cloneNameWithOwner?: string
  /** New branch for the worktree */
  branch: string
}

export interface CreateWorktreeResult {
  /** The new worktree folder: becomes the session's working directory */
  path: string
  branch: string
  /** What it branched from, e.g. `origin/main` */
  base: string
  /** True when the GitHub repo was cloned first */
  cloned: boolean
}

/** Optional starting context. It is resolved only when the first message is sent. */
export type RepositoryStart =
  | { kind: 'branch'; branch: string; copy?: boolean }
  | { kind: 'pull-request'; number: number; repository?: string; copy?: boolean }
  | { kind: 'github-issue'; number: number; repository?: string }
  | { kind: 'linear-issue'; identifier: string; url?: string }

export function parseRepositoryStart(value: string): RepositoryStart {
  const input = value.trim()
  if (!input || input.length > 500 || /[\u0000-\u001f]/.test(input)) throw new Error('Enter a branch, PR or issue reference.')
  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) throw new Error('Use a canonical HTTPS issue or pull request URL.')
    const github = /^\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/([1-9]\d*)\/?$/.exec(url.pathname)
    if (url.hostname === 'github.com' && github) {
      return { kind: github[3] === 'pull' ? 'pull-request' : 'github-issue', repository: `${github[1]}/${github[2]}`, number: Number(github[4]) }
    }
    const linear = /^\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-[1-9]\d*)(?:\/[^/]+)?\/?$/.exec(url.pathname)
    if (url.hostname === 'linear.app' && linear) return { kind: 'linear-issue', identifier: linear[1]!.toUpperCase(), url: url.href }
    throw new Error('Use a github.com issue/PR or linear.app issue URL.')
  }
  const pr = /^(?:pr:|pull:)\s*([1-9]\d*)$/i.exec(input)
  if (pr) return { kind: 'pull-request', number: Number(pr[1]) }
  const issue = /^(?:issue:|#)\s*([1-9]\d*)$/i.exec(input)
  if (issue) return { kind: 'github-issue', number: Number(issue[1]) }
  const linear = /^(?:linear:)?([A-Za-z][A-Za-z0-9]*-[1-9]\d*)$/i.exec(input)
  if (linear) return { kind: 'linear-issue', identifier: linear[1]!.toUpperCase() }
  const branch = input.replace(/^branch:\s*/i, '')
  if (branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') || /[\s~^:?*\[\\]|\.\.|@\{|\/\//.test(branch) || branch.endsWith('.lock') || branch === '@') throw new Error('Enter a valid Git branch name.')
  return { kind: 'branch', branch }
}
