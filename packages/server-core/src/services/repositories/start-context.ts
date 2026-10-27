import { execFile } from 'node:child_process'
import type { RepositoryStart } from '@craft-agent/shared/protocol'
import { parseRepositoryStart } from '@craft-agent/shared/protocol'
import { runGit, runGitResult } from '../git'
import { isGitHubDotCom, parseRemoteUrl } from '../pr-watch/remote-url'

export interface ResolvedRepositoryStart {
  baseBranch?: string
  existingBranch?: string
  taskTitle?: string
  context?: string
  pullRequestUrl?: string
}
export interface LinearStartIssue { title: string; description?: string; url: string; branchName?: string }
export interface StartContextDependencies {
  readGitHub?: (args: string[], cwd: string) => Promise<any>
  /** Must use the workspace's configured Linear source/credential relay. */
  resolveLinearIssue?: (identifier: string) => Promise<LinearStartIssue>
}

function githubJson(args: string[], cwd: string): Promise<any> {
  return new Promise((resolve, reject) => execFile('gh', args, { cwd, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
    if (error) return reject(new Error('Could not read this GitHub reference with the connected account.'))
    try { resolve(JSON.parse(stdout)) } catch { reject(new Error('GitHub returned an invalid reference.')) }
  }))
}
function contextText(kind: string, item: { title: string; body?: string; url: string }): string {
  return `<task-reference kind="${kind}">\n${item.url}\n${item.title.slice(0, 500)}\n\n${(item.body ?? '').slice(0, 50_000)}\n</task-reference>`
}
async function validateBranch(dir: string, branch: string): Promise<void> {
  if (typeof branch !== 'string' || branch.startsWith('-') || !(await runGit(dir, ['check-ref-format', '--branch', branch]))) throw new Error('The reference has an invalid branch name.')
}
async function existingBranch(dir: string, branch: string): Promise<void> {
  await validateBranch(dir, branch)
  if (await runGit(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])) return
  const remote = await runGitResult(dir, ['fetch', '--quiet', '--', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`])
  if (!remote.ok) throw new Error(`Branch "${branch}" could not be fetched from origin.`)
  const result = await runGitResult(dir, ['branch', '--track', '--', branch, `refs/remotes/origin/${branch}`])
  if (!result.ok && !await runGit(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])) throw new Error('Could not prepare the selected branch.')
}

/** Prepare a fork tracking branch without changing any checked-out branch or existing upstream. */
async function forkBranch(dir: string, number: number, owner: string, repository: string, head: string): Promise<void> {
  if (typeof owner !== 'string' || typeof repository !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repository) || ['.', '..'].includes(repository)) throw new Error('GitHub returned an invalid fork repository.')
  const remote = `craft-pr-${number}-${owner}`
  const url = `https://github.com/${owner}/${repository}.git`
  const currentUrl = await runGit(dir, ['config', '--get', `remote.${remote}.url`])
  if (currentUrl && currentUrl !== url) throw new Error('The PR remote name is already used by another repository.')
  if (!currentUrl && !(await runGitResult(dir, ['remote', 'add', remote, url])).ok) throw new Error('Could not add the PR fork remote.')
  const reference = `refs/remotes/${remote}/${head}`
  if (!(await runGitResult(dir, ['fetch', '--quiet', '--', remote, `refs/heads/${head}:${reference}`])).ok) throw new Error('Could not fetch the PR fork branch.')
  const local = await runGit(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${head}^{commit}`])
  if (local) {
    const fetched = await runGit(dir, ['rev-parse', '--verify', '--quiet', `${reference}^{commit}`])
    const upstreamRemote = await runGit(dir, ['config', '--get', `branch.${head}.remote`])
    const upstreamMerge = await runGit(dir, ['config', '--get', `branch.${head}.merge`])
    if (local !== fetched || upstreamRemote !== remote || upstreamMerge !== `refs/heads/${head}`) throw new Error('A different local branch already uses this PR branch name. Choose a new branch copy instead.')
    return
  }
  const added = await runGitResult(dir, ['branch', '--track', '--', head, reference])
  if (!added.ok) throw new Error('Could not prepare the PR tracking branch.')
}

/** Resolve read-only task metadata; branch fetches happen here only on first send. */
export async function resolveRepositoryStart(dir: string, start: RepositoryStart | undefined, deps: StartContextDependencies = {}): Promise<ResolvedRepositoryStart> {
  if (!start) return {}
  if (typeof start !== 'object' || !['branch', 'pull-request', 'github-issue', 'linear-issue'].includes(start.kind)) throw new Error('Invalid starting reference.')
  if ('copy' in start && start.copy !== undefined && typeof start.copy !== 'boolean') throw new Error('Invalid branch copy option.')
  if ('repository' in start && start.repository !== undefined && typeof start.repository !== 'string') throw new Error('Invalid reference repository.')
  if (start.kind === 'branch') {
    await validateBranch(dir, start.branch)
    if (start.copy) return { baseBranch: start.branch }
    await existingBranch(dir, start.branch)
    return { existingBranch: start.branch, taskTitle: start.branch.split('/').pop() }
  }
  if (start.kind === 'linear-issue') {
    if (!/^[A-Z][A-Z0-9]*-[1-9]\d*$/.test(start.identifier)) throw new Error('Invalid Linear issue identifier.')
    if (start.url) {
      const parsed = parseRepositoryStart(start.url)
      if (parsed.kind !== 'linear-issue' || parsed.identifier !== start.identifier) throw new Error('The Linear URL does not match the issue.')
    }
    if (!deps.resolveLinearIssue) throw new Error('Connect a Linear source to resolve this issue before starting the chat.')
    const issue = await deps.resolveLinearIssue(start.identifier)
    if (!issue?.title || typeof issue.url !== 'string') throw new Error('The Linear source did not return this issue.')
    const canonical = parseRepositoryStart(issue.url)
    if (canonical.kind !== 'linear-issue' || canonical.identifier !== start.identifier) throw new Error('The Linear source returned a different issue.')
    return { taskTitle: `${start.identifier} ${issue.title}`, context: contextText('linear-issue', { title: issue.title, body: issue.description, url: issue.url }) }
  }
  if (!Number.isSafeInteger(start.number) || start.number < 1) throw new Error('Invalid GitHub reference number.')
  const origin = await runGit(dir, ['config', '--get', 'remote.origin.url'])
  const coords = origin ? parseRemoteUrl(origin) : null
  if (!coords || !isGitHubDotCom(coords.host)) throw new Error('This repository needs a GitHub.com origin for issue/PR references.')
  const repository = `${coords.owner}/${coords.repo}`
  if (start.repository && start.repository.toLowerCase() !== repository.toLowerCase()) throw new Error('This issue/PR belongs to a different repository. Select that repository first.')
  const read = deps.readGitHub ?? githubJson
  if (start.kind === 'github-issue') {
    const issue = await read(['issue', 'view', String(start.number), '--repo', repository, '--json', 'number,title,body,url'], dir)
    const canonical = parseRepositoryStart(issue.url ?? '')
    if (canonical.kind !== 'github-issue' || canonical.number !== start.number || canonical.repository?.toLowerCase() !== repository.toLowerCase() || !issue.title) throw new Error('GitHub returned a different issue.')
    return { taskTitle: `issue ${start.number} ${issue.title}`, context: contextText('github-issue', issue) }
  }
  const pr = await read(['pr', 'view', String(start.number), '--repo', repository, '--json', 'number,title,body,url,headRefName,baseRefName,isCrossRepository,headRepositoryOwner,headRepository'], dir)
  const canonical = parseRepositoryStart(pr.url ?? '')
  if (canonical.kind !== 'pull-request' || canonical.number !== start.number || canonical.repository?.toLowerCase() !== repository.toLowerCase() || !pr.title) throw new Error('GitHub returned a different pull request.')
  await validateBranch(dir, pr.headRefName)
  await validateBranch(dir, pr.baseRefName)
  if (pr.isCrossRepository && !start.copy) {
    await forkBranch(dir, start.number, pr.headRepositoryOwner?.login, pr.headRepository?.name, pr.headRefName)
    return { existingBranch: pr.headRefName, baseBranch: pr.baseRefName, taskTitle: pr.title, context: contextText('pull-request', pr), pullRequestUrl: pr.url }
  }
  if (pr.isCrossRepository) {
    const target = `refs/remotes/craft-pr/${start.number}`
    const result = await runGitResult(dir, ['fetch', '--quiet', '--', 'origin', `refs/pull/${start.number}/head:${target}`])
    if (!result.ok) throw new Error('Could not fetch this pull request.')
    return { baseBranch: target, taskTitle: pr.title, context: contextText('pull-request', pr), pullRequestUrl: pr.url }
  }
  if (start.copy) return { baseBranch: pr.headRefName, taskTitle: pr.title, context: contextText('pull-request', pr), pullRequestUrl: pr.url }
  await existingBranch(dir, pr.headRefName)
  return { existingBranch: pr.headRefName, baseBranch: pr.baseRefName, taskTitle: pr.title, context: contextText('pull-request', pr), pullRequestUrl: pr.url }
}
