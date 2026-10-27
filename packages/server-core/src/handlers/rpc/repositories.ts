/**
 * Repository picker RPCs: list the repositories a new session can start from (local +
 * `gh repo list`) and create the session's worktree. They run on the workspace server, where the
 * repositories and the `gh` login live.
 */

import { RPC_CHANNELS, type CreateWorktreeRequest, type CreateWorktreeResult, type RepoListing } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId, getWorkspaces } from '@craft-agent/shared/config'
import { expandPath } from '@craft-agent/shared/utils'
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { cloneRootFor, discoverLocalRepos, repoCommandDir } from '../../services/repositories/discover'
import { runGit } from '../../services/git'
import { isGitHubDotCom, parseRemoteUrl } from '../../services/pr-watch/remote-url'
import { listGitHubRepos } from '../../services/repositories/github'
import { createWorktree, resolveWorktreeRepository } from '../../services/repositories/worktree'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.git.LIST_REPOS,
  RPC_CHANNELS.git.GET_REPOSITORY_IDENTITY,
  RPC_CHANNELS.git.CREATE_WORKTREE,
] as const

/** Recent folders the client may send (it keeps the history); more would only slow the scan. */
const MAX_RECENT_DIRS = 20

function workspaceFolders(workspaceId: string): { root: string; folder?: string } {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) throw new Error('Unknown workspace')
  // Stored as typed in Settings (`~/code`); the file system needs it expanded
  const folder = loadWorkspaceConfig(workspace.rootPath)?.defaults?.workingDirectory
  return { root: workspace.rootPath, folder: folder ? expandPath(folder) : undefined }
}

async function listing(workspaceId: string, recentDirs: unknown, refreshGitHub: boolean, query?: string): Promise<RepoListing> {
  const { root, folder } = workspaceFolders(workspaceId)
  const recent = Array.isArray(recentDirs) ? recentDirs.filter((d): d is string => typeof d === 'string').slice(0, MAX_RECENT_DIRS) : []
  // Workspace data folders (sessions, sources) hold no code: the repo scan never enters them
  const skipDirs = [root, ...getWorkspaces().map(workspace => expandPath(workspace.rootPath))]
  const [local, github] = await Promise.all([
    discoverLocalRepos({ workspaceFolder: folder, recentDirs: recent, skipDirs }),
    listGitHubRepos({ fresh: refreshGitHub, query }),
  ])
  // A GitHub repo that is already on disk is listed once, as the local one
  const localNames = new Set(local.map(repo => repo.nameWithOwner?.toLowerCase()).filter(Boolean))
  return {
    local,
    github: github.repos.filter(repo => !localNames.has(repo.nameWithOwner.toLowerCase())),
    cloneRoot: cloneRootFor(local, folder, root),
    githubUnavailable: github.unavailable,
  }
}

export function registerRepositoryHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.git.GET_REPOSITORY_IDENTITY, async (_ctx, dirPath: string): Promise<string | null> => {
    if (typeof dirPath !== 'string' || !dirPath.trim()) return null
    const origin = await runGit(repoCommandDir(dirPath), ['config', '--get', 'remote.origin.url'])
    const coordinates = origin ? parseRemoteUrl(origin) : null
    // Never return a remote URL: it may contain credentials. Public owner avatars are GitHub-only.
    return coordinates && isGitHubDotCom(coordinates.host)
      && /^[\w.-]+$/.test(coordinates.owner) && /^[\w.-]+$/.test(coordinates.repo)
      ? `${coordinates.owner}/${coordinates.repo}` : null
  })
  server.handle(RPC_CHANNELS.git.LIST_REPOS, async (_ctx, workspaceId: string, recentDirs: string[], options?: { refreshGitHub?: boolean; query?: string }): Promise<RepoListing> => {
    const query = typeof options?.query === 'string' ? options.query.trim().slice(0, 250) : undefined
    return listing(workspaceId, recentDirs, !!options?.refreshGitHub, query)
  })

  server.handle(RPC_CHANNELS.git.CREATE_WORKTREE, async (_ctx, workspaceId: string, request: CreateWorktreeRequest, recentDirs: string[]): Promise<CreateWorktreeResult> => {
    // The clone folder is derived here, as in the listing, never taken from the client
    const { cloneRoot } = await listing(workspaceId, recentDirs, false)
    if (request.sessionId) {
      const session = await deps.sessionManager.getSession(request.sessionId)
      if (!session || session.workspaceId !== workspaceId || session.isProcessing || session.messages.length > 0 || session.hidden || session.parentSessionId) {
        throw new Error('Choose the repository in a new session in this workspace')
      }
      const { gitDir, cloned } = await resolveWorktreeRepository(request, cloneRoot)
      return { ...await deps.sessionManager.prepareNewSessionWorktree(workspaceId, request.sessionId, repoCommandDir(gitDir)), cloned }
    }
    return createWorktree(request, { cloneRoot })
  })
}
