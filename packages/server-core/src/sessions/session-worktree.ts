import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { ProjectConfig } from '@craft-agent/shared/projects'
import type { CreateSessionOptions } from '@craft-agent/shared/protocol'
import type { SessionWorktreeMetadata } from '@craft-agent/shared/sessions'
import { expandPath } from '@craft-agent/shared/utils'
import { commonGitDir } from '../services/repositories/discover'

function isInsideDirectory(directory: string, parent: string): boolean {
  const child = relative(parent, directory)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

/** Resolve aliases even when the final subdirectory was removed while a session still refers to it. */
async function realDirectoryAllowMissing(directory: string): Promise<string> {
  try {
    return await realpath(directory)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    const parent = dirname(directory)
    if (parent === directory) return directory
    return join(await realDirectoryAllowMissing(parent), basename(directory))
  }
}

/** A checkout cannot be removed while another chat references its root, a child or an alias. */
export async function isSessionDirectoryInWorktree(
  directory: string | undefined,
  worktreePath: string,
): Promise<boolean> {
  if (!directory || !worktreePath) return false
  const expandedDirectory = expandPath(directory)
  const expandedWorktree = expandPath(worktreePath)
  // Keep lexical descendants protected even when their directory or checkout no longer exists.
  if (isInsideDirectory(expandedDirectory, expandedWorktree)) return true
  const [realDirectory, realWorktree] = await Promise.all([
    realDirectoryAllowMissing(expandedDirectory),
    realDirectoryAllowMissing(expandedWorktree),
  ])
  return isInsideDirectory(realDirectory, realWorktree)
}

/** Capture the project's policy only for new, independent chats using its folder. */
export function resolveSessionWorktreePolicy(
  project: Pick<ProjectConfig, 'workingDirectory' | 'worktreeSettings'>,
  options?: CreateSessionOptions,
): SessionWorktreeMetadata | undefined {
  if (project.worktreeSettings?.enabled !== true || !project.workingDirectory) return
  if (options?.worktree === 'none') return
  if (options?.workingDirectory !== undefined && options.workingDirectory !== 'user_default') return
  if (options?.hidden || (options?.systemPromptPreset && options.systemPromptPreset !== 'default')) return
  if (options?.parentSessionId || options?.branchFromSessionId || options?.branchFromMessageId) return
  if (options?.taskSlug || options?.taskRunId || options?.taskNodeId || options?.taskDraft) return

  return {
    repositoryPath: project.workingDirectory,
    baseBranch: project.worktreeSettings.baseBranch,
    cleanupOnArchive: project.worktreeSettings.cleanupOnArchive === true,
  }
}

/** Every new independent chat isolates its repository, regardless of agent profile. */
export async function defaultSessionWorktreePolicy(directory: string | undefined, options?: CreateSessionOptions): Promise<SessionWorktreeMetadata | undefined> {
  if (options?.worktree === 'none' || options?.workingDirectory === 'none') return
  const policy = resolveSessionWorktreePolicy({ workingDirectory: directory || '.', worktreeSettings: { enabled: true } }, {
    ...options, workingDirectory: 'user_default',
  })
  if (!policy) return
  const repositoryPath = directory ? expandPath(directory) : ''
  return { ...policy, repositoryPath, needsRepository: !repositoryPath || !await commonGitDir(repositoryPath) }
}
