import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, chmod, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listWorktreeFiles, MAX_TEXT_BYTES, readWorktreeFile, writeWorktreeFile } from './files'

const directories: string[] = []
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'craft-file-editor-'))
  directories.push(root)
  execFileSync('git', ['init', '--quiet', root])
  await mkdir(join(root, 'src')); await mkdir(join(root, 'node_modules'))
  await writeFile(join(root, 'src/app.ts'), 'export const value = 1\r\n')
  await writeFile(join(root, 'README.md'), '# Fixture\n')
  return root
}

describe('worktree files', () => {
  test('browses the actual Git worktree lazily from a nested cwd and omits heavy directories', async () => {
    const root = await fixture()
    const listing = await listWorktreeFiles(join(root, 'src'))
    expect(listing.entries.map(item => item.name)).toEqual(['src', 'README.md'])
    expect((await listWorktreeFiles(root, 'src')).entries[0]?.path).toBe('src/app.ts')
    expect((await readWorktreeFile(root, 'src/app.ts')).content).toBe('export const value = 1\r\n')
  })

  test('never treats a session history folder as the repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'craft-history-only-')); directories.push(root)
    await writeFile(join(root, 'session.jsonl'), '{"history":true}')
    await expect(listWorktreeFiles(root)).rejects.toMatchObject({ code: 'not-git' })
  })

  test('rejects traversal, Git metadata, absolute paths and symlink files/directories', async () => {
    const root = await fixture()
    await symlink(join(root, 'src'), join(root, 'shortcut'))
    await symlink(join(root, 'README.md'), join(root, 'linked.md'))
    for (const path of ['../README.md', '/etc/passwd', '.git/config', '.GIT/config', '.git./config', 'src/../../README.md', 'src\\app.ts', 'C:/test', 'src//app.ts']) {
      await expect(readWorktreeFile(root, path)).rejects.toMatchObject({ code: 'invalid-path' })
    }
    await expect(readWorktreeFile(root, 'linked.md')).rejects.toMatchObject({ code: 'symlink' })
    await expect(listWorktreeFiles(root, 'shortcut')).rejects.toMatchObject({ code: 'symlink' })
  })

  test('reports binary, invalid UTF-8 and oversized files rather than corrupting text', async () => {
    const root = await fixture()
    await writeFile(join(root, 'binary'), Buffer.from([65, 0, 66]))
    await writeFile(join(root, 'encoding'), Buffer.from([255, 254]))
    await writeFile(join(root, 'large'), Buffer.alloc(MAX_TEXT_BYTES + 1, 65))
    await expect(readWorktreeFile(root, 'binary')).rejects.toMatchObject({ code: 'binary' })
    await expect(readWorktreeFile(root, 'encoding')).rejects.toMatchObject({ code: 'binary' })
    await expect(readWorktreeFile(root, 'large')).rejects.toMatchObject({ code: 'too-large' })
  })

  test('saves with an opaque version, preserves permissions and refuses a stale edit', async () => {
    const root = await fixture()
    await chmod(join(root, 'src/app.ts'), 0o755)
    const original = await readWorktreeFile(root, 'src/app.ts')
    const saved = await writeWorktreeFile(root, { path: original.path, expectedVersion: original.version, content: 'export const value = 2\r\n' })
    expect(saved.content).toBe('export const value = 2\r\n')
    expect(saved.version).not.toBe(original.version)
    expect((await stat(join(root, 'src/app.ts'))).mode & 0o777).toBe(0o755)
    await expect(writeWorktreeFile(root, { path: original.path, expectedVersion: original.version, content: 'stale' })).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(join(root, 'src/app.ts'), 'utf8')).toBe(saved.content)
    expect((await readdir(join(root, 'src'))).some(name => name.startsWith('.craft-edit-'))).toBe(false)
  })

  test('an agent edit or archive guard occurring during save preserves external changes and cleans its temporary file', async () => {
    const root = await fixture()
    const original = await readWorktreeFile(root, 'src/app.ts')
    await expect(writeWorktreeFile(root, { path: original.path, expectedVersion: original.version, content: 'human edit' }, async () => {
      await writeFile(join(root, 'src/app.ts'), 'agent edit')
    })).rejects.toMatchObject({ code: 'conflict' })
    const latest = await readWorktreeFile(root, 'src/app.ts')
    await expect(writeWorktreeFile(root, { path: latest.path, expectedVersion: latest.version, content: 'human edit' }, () => { throw new Error('Archived') })).rejects.toThrow('Archived')
    expect(await readFile(join(root, 'src/app.ts'), 'utf8')).toBe('agent edit')
    expect((await readdir(join(root, 'src'))).some(name => name.startsWith('.craft-edit-'))).toBe(false)
  })

  test('concurrent editor saves serialize and cannot both overwrite the same base', async () => {
    const root = await fixture()
    const original = await readWorktreeFile(root, 'src/app.ts')
    const input = { path: original.path, expectedVersion: original.version }
    const results = await Promise.allSettled([
      writeWorktreeFile(root, { ...input, content: 'first' }),
      writeWorktreeFile(root, { ...input, content: 'second' }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  })

  test('versions bind the checkout as well as content so a directory change cannot overwrite another worktree', async () => {
    const first = await fixture(); const second = await fixture()
    const original = await readWorktreeFile(first, 'src/app.ts')
    await expect(writeWorktreeFile(second, { path: original.path, expectedVersion: original.version, content: 'wrong checkout' })).rejects.toMatchObject({ code: 'conflict' })
  })
})
