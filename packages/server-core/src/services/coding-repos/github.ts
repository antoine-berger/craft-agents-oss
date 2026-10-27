/**
 * The signed-in user's owned, collaborator and organization repositories, via `gh api user/repos`.
 * Search only this authenticated catalog; public GitHub search would include unrelated repositories.
 * `gh` owns the login. Cache the complete paginated catalog so subsequent searches are local.
 */

import { execFile } from 'node:child_process'
import type { GitHubRepo, RepoListing } from '@craft-agent/shared/protocol'

const LIST_LIMIT = 100
const CACHE_MS = 60_000

type GitHubRepoResult = { repos: GitHubRepo[]; unavailable?: RepoListing['githubUnavailable'] }
let cache: { at: number; value: GitHubRepoResult } | undefined
let pending: Promise<GitHubRepoResult> | undefined

interface GhRepo {
  nameWithOwner?: string
  fullName?: string
  description?: string | null
  isPrivate: boolean
  updatedAt?: string
}

export function parseGhRepoList(stdout: string): GitHubRepo[] {
  const parsed = JSON.parse(stdout) as GhRepo[]
  return parsed.map(repo => ({
    kind: 'github',
    nameWithOwner: repo.nameWithOwner ?? repo.fullName ?? '',
    description: repo.description || undefined,
    isPrivate: repo.isPrivate,
    updatedAt: repo.updatedAt ? Date.parse(repo.updatedAt) : undefined,
  }))
}

/** gh emits one compact JSON array per page; --slurp cannot be combined with --jq. */
export function parseGhRepoPages(stdout: string): GitHubRepo[] {
  return stdout.split(/\r?\n/).filter(line => line.trim()).flatMap(parseGhRepoList)
}

/** Filter after pagination, so a matching repo beyond the first page is still found. */
export function filterGitHubRepos(repos: readonly GitHubRepo[], query = ''): GitHubRepo[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return repos.filter(repo => {
    const text = `${repo.nameWithOwner} ${repo.description ?? ''}`.toLowerCase()
    return words.every(word => text.includes(word))
  }).slice(0, LIST_LIMIT)
}

async function accessibleGitHubRepos(fresh: boolean): Promise<GitHubRepoResult> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value
  if (pending) return pending
  pending = new Promise((done) => {
    execFile(
      'gh',
      ['api', '--paginate',
        'user/repos?affiliation=owner,collaborator,organization_member&visibility=all&per_page=100&sort=updated&direction=desc',
        '--jq', '[.[] | {nameWithOwner: .full_name, description, isPrivate: .private, updatedAt: .updated_at}] | @json'],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        let value: GitHubRepoResult
        if (error) {
          value = { repos: [], unavailable: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-installed' : 'not-signed-in' }
        } else {
          try {
            value = { repos: parseGhRepoPages(stdout) }
          } catch {
            value = { repos: [], unavailable: 'not-signed-in' }
          }
        }
        cache = { at: Date.now(), value }
        done(value)
      },
    )
  })
  try {
    return await pending
  } finally {
    pending = undefined
  }
}

export async function listGitHubRepos({ fresh = false, query }: { fresh?: boolean; query?: string } = {}): Promise<GitHubRepoResult> {
  const result = await accessibleGitHubRepos(fresh)
  return { ...result, repos: filterGitHubRepos(result.repos, query) }
}

/** `owner/repo` with GitHub's allowed characters only (it ends up in a `gh` argument and a path). */
export function isValidNameWithOwner(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !value.split('/').some(part => part === '.' || part === '..')
}
