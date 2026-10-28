import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { WorktreeDirectory, WorktreeFileWrite, WorktreeTextFile } from '../../../../shared/src/protocol/worktree-files'
import { runGit } from '../git'

export const MAX_TEXT_BYTES = 512 * 1024
const MAX_DIRECTORY_ENTRIES = 1_000
const OMITTED_DIRECTORIES = new Set(['.git', 'node_modules', '.next', '.cache', '.turbo', 'dist', 'build', 'coverage', 'target'])
const writes = new Map<string, Promise<unknown>>()

export class WorktreeFileError extends Error {
  constructor(message: string, readonly code: 'not-git' | 'invalid-path' | 'symlink' | 'not-file' | 'not-directory' | 'binary' | 'too-large' | 'conflict') {
    super(message)
    this.name = 'WorktreeFileError'
  }
}

function pathParts(path: string): string[] {
  if (typeof path !== 'string' || isAbsolute(path) || /[\\\0]/.test(path)) throw new WorktreeFileError('Use a relative worktree path.', 'invalid-path')
  const parts = path === '' ? [] : path.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /^\.git[. ]*$/i.test(part) || /^[A-Za-z]:/.test(part))) {
    throw new WorktreeFileError('This path is outside the editable worktree.', 'invalid-path')
  }
  return parts
}

async function worktreeRoot(directory: string): Promise<string> {
  const root = await runGit(directory, ['rev-parse', '--show-toplevel'])
  if (!root) throw new WorktreeFileError('This session has no Git worktree.', 'not-git')
  return realpath(root)
}

async function checkedPath(root: string, path: string): Promise<string> {
  let current = root
  for (const part of pathParts(path)) {
    current = join(current, part)
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new WorktreeFileError('Symbolic links are not opened by the worktree editor.', 'symlink')
  }
  const actual = await realpath(current)
  const child = relative(root, actual)
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new WorktreeFileError('This path is outside the worktree.', 'invalid-path')
  return current
}

function version(root: string, path: string, bytes: Uint8Array): string {
  return createHash('sha256').update(root).update('\0').update(path).update('\0').update(bytes).digest('hex')
}

async function readAt(root: string, path: string): Promise<WorktreeTextFile> {
  if (!path) throw new WorktreeFileError('Choose a file to open.', 'not-file')
  const target = await checkedPath(root, path)
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new WorktreeFileError('This path is not a regular file.', 'not-file')
    if (info.size > MAX_TEXT_BYTES) throw new WorktreeFileError('This file exceeds the 512 KiB editor limit.', 'too-large')
    const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (!chunk.bytesRead) break
      bytesRead += chunk.bytesRead
    }
    if (bytesRead > MAX_TEXT_BYTES) throw new WorktreeFileError('This file exceeds the 512 KiB editor limit.', 'too-large')
    await checkedPath(root, path)
    const current = await lstat(target)
    if (current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size || current.mtimeMs !== info.mtimeMs || current.ctimeMs !== info.ctimeMs) throw new WorktreeFileError('The file changed while opening. Reload it.', 'conflict')
    const bytes = buffer.subarray(0, bytesRead)
    if (bytes.includes(0)) throw new WorktreeFileError('Binary files cannot be edited here.', 'binary')
    let content: string
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
    catch { throw new WorktreeFileError('This file is not UTF-8 text.', 'binary') }
    return { path, content, version: version(root, path, bytes), modifiedAt: info.mtimeMs }
  } finally { await handle.close() }
}

export async function listWorktreeFiles(directory: string, path = ''): Promise<WorktreeDirectory> {
  const root = await worktreeRoot(directory)
  const target = await checkedPath(root, path)
  if (!(await lstat(target)).isDirectory()) throw new WorktreeFileError('This path is not a directory.', 'not-directory')
  const items = (await readdir(target, { withFileTypes: true }))
    .filter(item => item.name !== '.git' && !(item.isDirectory() && OMITTED_DIRECTORIES.has(item.name)))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  return {
    rootName: basename(root), path, truncated: items.length > MAX_DIRECTORY_ENTRIES,
    entries: items.slice(0, MAX_DIRECTORY_ENTRIES).map(item => ({
      name: item.name, path: path ? `${path}/${item.name}` : item.name,
      kind: item.isDirectory() ? 'directory' : item.isSymbolicLink() ? 'symlink' : 'file',
    })),
  }
}

export async function readWorktreeFile(directory: string, path: string): Promise<WorktreeTextFile> {
  return readAt(await worktreeRoot(directory), path)
}

/** Same-process saves serialize; external edits are checked again immediately before atomic replacement. */
export async function writeWorktreeFile(directory: string, input: WorktreeFileWrite, beforePublish: () => void | Promise<void> = () => {}): Promise<WorktreeTextFile> {
  if (!input || typeof input.content !== 'string' || typeof input.expectedVersion !== 'string' || !/^[a-f\d]{64}$/.test(input.expectedVersion)) {
    throw new WorktreeFileError('Reload the file before saving.', 'conflict')
  }
  const bytes = Buffer.from(input.content, 'utf8')
  if (bytes.length > MAX_TEXT_BYTES) throw new WorktreeFileError('This file exceeds the 512 KiB editor limit.', 'too-large')
  if (bytes.includes(0)) throw new WorktreeFileError('Binary files cannot be edited here.', 'binary')
  const root = await worktreeRoot(directory)
  const target = await checkedPath(root, input.path)
  const previous = writes.get(target) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(async () => {
    const current = await readAt(root, input.path)
    if (current.version !== input.expectedVersion) throw new WorktreeFileError('The file changed outside this editor. Reload before saving; your draft is preserved.', 'conflict')
    const info = await lstat(target)
    const temporary = join(dirname(target), `.craft-edit-${randomUUID()}.tmp`)
    let temporaryExists = false
    try {
      const handle = await open(temporary, 'wx', info.mode & 0o777)
      temporaryExists = true
      try { await handle.chmod(info.mode & 0o777); await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      await beforePublish()
      await checkedPath(root, input.path)
      const latest = await readAt(root, input.path)
      const latestInfo = await lstat(target)
      if (latest.version !== input.expectedVersion || latestInfo.dev !== info.dev || latestInfo.ino !== info.ino) {
        throw new WorktreeFileError('The file changed outside this editor. Reload before saving; your draft is preserved.', 'conflict')
      }
      await rename(temporary, target)
      temporaryExists = false
      return readAt(root, input.path)
    } finally { if (temporaryExists) await unlink(temporary).catch(() => {}) }
  })
  writes.set(target, operation)
  try { return await operation } finally { if (writes.get(target) === operation) writes.delete(target) }
}
