import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import type { GitReviewFile, GitReviewLine, GitReviewSnapshot } from '@craft-agent/shared/protocol'

const MAX_FILES = 200
const MAX_PATCH_BYTES = 512 * 1024
const MAX_LINES_PER_FILE = 5_000
const MAX_TOTAL_LINES = 25_000
const MAX_TOTAL_BYTES = 4 * 1024 * 1024

async function git(directory: string, args: string[], maxBuffer = 2 * 1024 * 1024): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'color.ui=false', '-C', directory, ...args], { encoding: 'utf8', timeout: 15_000, maxBuffer, windowsHide: true }, (error, stdout) => {
      const truncated = (error as NodeJS.ErrnoException | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      if (error && !truncated) return reject(new Error('Git review could not read this repository. Refresh after the current Git operation finishes.'))
      resolve({ text: String(stdout).slice(0, maxBuffer), truncated })
    })
  })
}
async function tryGit(directory: string, args: string[]): Promise<string | null> {
  try { return (await git(directory, args)).text.trim() || null } catch { return null }
}

export function parseReviewPatch(patch: string, limit = MAX_LINES_PER_FILE): { lines: GitReviewLine[]; truncated: boolean } {
  const result: GitReviewLine[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const text of patch.replace(/\n$/, '').split('\n')) {
    if (result.length >= limit) return { lines: result, truncated: true }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true
      result.push({ kind: 'hunk', text })
    } else if (inHunk && text.startsWith('+')) {
      result.push({ kind: 'add', text: text.slice(1), newLine: newLine++ })
    } else if (inHunk && text.startsWith('-')) {
      result.push({ kind: 'remove', text: text.slice(1), oldLine: oldLine++ })
    } else if (inHunk && text.startsWith(' ')) {
      result.push({ kind: 'context', text: text.slice(1), oldLine: oldLine++, newLine: newLine++ })
    } else if (text && !text.startsWith('diff --git ') && !text.startsWith('index ') && !text.startsWith('--- ') && !text.startsWith('+++ ')) {
      result.push({ kind: 'meta', text })
    }
  }
  return { lines: result, truncated: false }
}

export function parseReviewNames(text: string): Array<Pick<GitReviewFile, 'path' | 'previousPath' | 'status'>> {
  const fields = text.split('\0')
  const result: Array<Pick<GitReviewFile, 'path' | 'previousPath' | 'status'>> = []
  for (let index = 0; index < fields.length;) {
    const code = fields[index++]
    if (!code) continue
    const first = fields[index++]
    if (first === undefined || !first) break
    if (code.startsWith('R') || code.startsWith('C')) {
      const next = fields[index++]
      if (!next) break
      result.push({ path: next, previousPath: first, status: code[0]! })
    } else result.push({ path: first, status: code[0]! })
  }
  return result
}

async function untrackedFile(directory: string, file: GitReviewFile, limit: number): Promise<GitReviewFile> {
  const path = join(directory, file.path)
  const rel = relative(directory, path)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Invalid repository path')
  const stat = await lstat(path)
  if (stat.isSymbolicLink()) return { ...file, notice: 'Symbolic link: target content is not read.' }
  if (!stat.isFile()) return { ...file, notice: 'Special file: content is not read.' }
  if (stat.size > MAX_PATCH_BYTES) return { ...file, truncated: true, notice: 'File exceeds the 512 KiB review limit.' }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const buffer = Buffer.alloc(MAX_PATCH_BYTES + 1)
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_PATCH_BYTES) return { ...file, truncated: true, notice: 'File grew beyond the review limit.' }
    const data = buffer.subarray(0, bytesRead)
    if (data.includes(0)) return { ...file, binary: true, notice: 'Binary file.' }
    const text = data.toString('utf8')
    const lines = text ? text.replace(/\n$/, '').split('\n') : []
    return { ...file, lines: lines.slice(0, limit).map((text, index) => ({ kind: 'add', text, newLine: index + 1 })), truncated: lines.length > limit }
  } finally { await handle.close() }
}

/** Compare the merge-base to the complete current worktree: commits, index, dirty and untracked. Never fetches or writes. */
export async function getGitReview(directory: string, policy?: { baseRef?: string; baseCommit?: string }): Promise<GitReviewSnapshot> {
  const repositoryPath = await tryGit(directory, ['rev-parse', '--show-toplevel'])
  if (!repositoryPath) throw new Error('This session is not in a Git worktree.')
  const headCommit = await tryGit(repositoryPath, ['rev-parse', '--verify', 'HEAD^{commit}'])
  if (!headCommit) throw new Error('The repository has no initial commit to review.')
  const branch = await tryGit(repositoryPath, ['symbolic-ref', '--short', '--quiet', 'HEAD']) ?? 'Detached HEAD'
  const candidates = [policy?.baseRef, await tryGit(repositoryPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']), 'refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master'].filter((value): value is string => !!value)
  let baseRef = 'HEAD'
  let baseCommit: string | null = null
  for (const candidate of [...new Set(candidates)]) {
    if (candidate.startsWith('-') || !(await tryGit(repositoryPath, ['check-ref-format', '--branch', candidate]))) continue
    const resolved = await tryGit(repositoryPath, ['rev-parse', '--verify', '--end-of-options', `${candidate}^{commit}`])
    if (!resolved) continue
    const common = await tryGit(repositoryPath, ['merge-base', resolved, headCommit])
    if (common) { baseRef = candidate; baseCommit = common; break }
  }
  if (!baseCommit && policy?.baseCommit && /^[a-f\d]{40,64}$/.test(policy.baseCommit)) {
    baseCommit = await tryGit(repositoryPath, ['rev-parse', '--verify', `${policy.baseCommit}^{commit}`])
    if (baseCommit) baseRef = 'Session base'
  }
  baseCommit ??= headCommit
  const [tracked, untracked] = await Promise.all([
    git(repositoryPath, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--find-renames', baseCommit, '--']),
    git(repositoryPath, ['ls-files', '--others', '--exclude-standard', '-z']),
  ])
  const entries = parseReviewNames(tracked.text)
  const seen = new Set(entries.map(file => file.path))
  for (const path of untracked.text.split('\0').filter(Boolean)) if (!seen.has(path)) entries.push({ path, status: '?' })
  const files: GitReviewFile[] = []
  let lineBudget = MAX_TOTAL_LINES
  let byteBudget = MAX_TOTAL_BYTES
  for (const entry of entries.slice(0, MAX_FILES)) {
    const file: GitReviewFile = { ...entry, untracked: entry.status === '?', binary: false, lines: [], truncated: false }
    if (lineBudget <= 0 || byteBudget < MAX_PATCH_BYTES) { files.push({ ...file, truncated: true, notice: 'Review size limit reached.' }); continue }
    const limit = Math.min(MAX_LINES_PER_FILE, lineBudget)
    try {
      if (file.untracked) files.push(await untrackedFile(repositoryPath, file, limit))
      else {
        const paths = file.previousPath ? [file.previousPath, file.path] : [file.path]
        const patch = await git(repositoryPath, ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--unified=3', baseCommit, '--', ...paths], MAX_PATCH_BYTES)
        const parsed = parseReviewPatch(patch.text, limit)
        files.push({ ...file, ...parsed, binary: /^(?:Binary files |GIT binary patch)/m.test(patch.text), truncated: patch.truncated || parsed.truncated })
      }
    } catch { files.push({ ...file, truncated: true, notice: 'File changed or became unavailable while reviewing. Refresh to retry.' }) }
    lineBudget -= files.at(-1)!.lines.length
    byteBudget -= files.at(-1)!.lines.reduce((total, line) => total + Buffer.byteLength(line.text), 0)
  }
  return { repositoryPath, branch, baseRef, baseCommit, headCommit, generatedAt: Date.now(), files, omittedFiles: Math.max(0, entries.length - MAX_FILES), truncated: tracked.truncated || untracked.truncated || entries.length > MAX_FILES || files.some(file => file.truncated) }
}
