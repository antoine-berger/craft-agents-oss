import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getGitReview, parseReviewPatch } from './review'
import { formatGitReviewComments } from '@craft-agent/shared/protocol'
let root: string
let repo: string
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'craft-git-review-'))); repo = join(root, 'repo'); mkdirSync(repo)
  git('init', '-b', 'main'); git('config', 'user.name', 'Review Test'); git('config', 'user.email', 'review@example.invalid')
  writeFileSync(join(repo, 'base.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(repo, 'rename.txt'), 'renamed content\n')
  writeFileSync(join(repo, 'delete.txt'), 'deleted content\n')
  writeFileSync(join(repo, '.gitignore'), '.env\n')
  git('add', '.'); git('commit', '-m', 'Base'); git('switch', '-c', 'person/feature')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
describe('complete branch review', () => {
  it('includes committed, staged, dirty, deleted, renamed and untracked files without changing Git state', async () => {
    writeFileSync(join(repo, 'committed.ts'), 'export const committed = true\n'); git('add', '.'); git('commit', '-m', 'Feature')
    writeFileSync(join(repo, 'staged.ts'), 'export const staged = true\n'); git('add', 'staged.ts')
    writeFileSync(join(repo, 'base.txt'), 'one\nchanged\nthree\n')
    git('rm', 'delete.txt'); git('mv', 'rename.txt', 'renamed file.txt')
    writeFileSync(join(repo, 'new\nfile.txt'), 'new line\n')
    writeFileSync(join(repo, '.env'), 'do not include\n')
    const before = git('status', '--porcelain=v1', '-z')
    const result = await getGitReview(repo, { baseRef: 'refs/heads/main' })
    expect(result.branch).toBe('person/feature')
    expect(result.baseCommit).toBe(git('rev-parse', 'main'))
    expect(result.files.map(f => f.path).sort()).toEqual(['base.txt', 'committed.ts', 'delete.txt', 'new\nfile.txt', 'renamed file.txt', 'staged.ts'].sort())
    expect(result.files.find(f => f.path === 'renamed file.txt')).toMatchObject({ previousPath: 'rename.txt', status: 'R' })
    expect(result.files.find(f => f.path === 'base.txt')?.lines).toContainEqual({ kind: 'add', text: 'changed', newLine: 2 })
    expect(result.files.find(f => f.path === 'delete.txt')?.lines).toContainEqual({ kind: 'remove', text: 'deleted content', oldLine: 1 })
    expect(result.files.find(f => f.path === 'new\nfile.txt')?.lines).toEqual([{ kind: 'add', text: 'new line', newLine: 1 }])
    expect(git('status', '--porcelain=v1', '-z')).toBe(before)
  })
  it('uses the merge-base rather than including later changes from main', async () => {
    writeFileSync(join(repo, 'feature.txt'), 'feature\n'); git('add', '.'); git('commit', '-m', 'Feature')
    git('switch', 'main'); writeFileSync(join(repo, 'main-only.txt'), 'main\n'); git('add', '.'); git('commit', '-m', 'Main advances'); git('switch', 'person/feature')
    const result = await getGitReview(repo)
    expect(result.files.map(f => f.path)).toEqual(['feature.txt'])
  })
  it('does not run external diff or textconv programs', async () => {
    const script = join(root, 'danger.sh'); const marker = join(root, 'ran')
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
    git('config', 'diff.external', script); git('config', 'diff.special.textconv', script)
    writeFileSync(join(repo, '.gitattributes'), '*.txt diff=special\n'); writeFileSync(join(repo, 'base.txt'), 'changed\n')
    const result = await getGitReview(repo)
    expect(result.files.some(f => f.path === 'base.txt')).toBe(true)
    expect(existsSync(marker)).toBe(false)
  })
  it('bounds large files and does not follow untracked symlinks or expose ignored files', async () => {
    writeFileSync(join(repo, 'binary.bin'), Buffer.from([0, 1, 2]))
    writeFileSync(join(repo, 'large.txt'), 'x'.repeat(600_000))
    writeFileSync(join(root, 'private.txt'), 'outside repository')
    symlinkSync(join(root, 'private.txt'), join(repo, 'link.txt'))
    const result = await getGitReview(repo)
    expect(result.files.find(f => f.path === 'binary.bin')?.binary).toBe(true)
    expect(result.files.find(f => f.path === 'large.txt')?.truncated).toBe(true)
    expect(result.files.find(f => f.path === 'link.txt')?.lines).toEqual([])
    expect(result.files.find(f => f.path === 'link.txt')?.notice).toContain('Symbolic link')
    expect(readFileSync(join(root, 'private.txt'), 'utf8')).toBe('outside repository')
  })
  it('bounds the combined content of many large one-line files', async () => {
    for (let index = 0; index < 12; index++) writeFileSync(join(repo, `large-${index}.txt`), 'x'.repeat(500_000))
    const result = await getGitReview(repo)
    expect(result.truncated).toBe(true)
    expect(result.files.some(file => file.notice === 'Review size limit reached.')).toBe(true)
    const bytes = result.files.reduce((sum, file) => sum + file.lines.reduce((n, line) => n + Buffer.byteLength(line.text), 0), 0)
    expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024)
  })
  it('maps hunk line numbers including blank/deleted lines and limits previews explicitly', () => {
    const parsed = parseReviewPatch('@@ -10,2 +20,2 @@\n-old\n+new\n \n', 10)
    expect(parsed.lines).toEqual([{ kind: 'hunk', text: '@@ -10,2 +20,2 @@' }, { kind: 'remove', text: 'old', oldLine: 10 }, { kind: 'add', text: 'new', newLine: 20 }, { kind: 'context', text: '', oldLine: 11, newLine: 21 }])
    expect(parseReviewPatch('@@ -1 +1 @@\n-old\n+new\n', 2).truncated).toBe(true)
  })
  it('formats comments with exact path, side, line, revision and quoted code', async () => {
    const snapshot = await getGitReview(repo)
    const text = formatGitReviewComments(snapshot, [{ path: 'base.txt', side: 'new', line: 2, excerpt: 'two', text: 'Please validate this value.' }])
    expect(text).toContain('"base.txt":2 (new)')
    expect(text).toContain(snapshot.headCommit.slice(0, 12))
    expect(text).toContain('Code: "two"')
  })
})
