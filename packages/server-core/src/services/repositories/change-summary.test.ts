import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseChangeNumstat, readSessionChangeSummary } from './change-summary'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'craft-change-summary-')); roots.push(root)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q')
  writeFileSync(join(root, 'app.ts'), 'a\nb\n')
  writeFileSync(join(root, 'old.ts'), 'one\ntwo\nthree\n')
  writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1]))
  git('add', '-A'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'base')
  return { root, git, base: git('rev-parse', 'HEAD') }
}

test('NUL parser does not turn rename paths containing tabs into statistics', () => {
  const diff = ['0\t0\t', 'old.ts', '3\t4\tfake.ts', '-\t-\tbinary.bin', ''].join('\0')
  expect(parseChangeNumstat(diff)).toEqual({ additions: 0, deletions: 0, files: 2, binaryFiles: 1 })
  expect(parseChangeNumstat('malformed\0')).toBeUndefined()
})

test('one Git diff reports tracked changes, including staged renames and binary files', async () => {
  const { root, git, base } = fixture()
  renameSync(join(root, 'old.ts'), join(root, '3\t4\tfake.ts')); git('add', '-A')
  writeFileSync(join(root, 'app.ts'), 'a\nc\nnew\n')
  writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 2, 3]))
  writeFileSync(join(root, 'untracked.ts'), 'not counted\n')
  const summary = await readSessionChangeSummary(root, base)
  expect(summary).toMatchObject({ additions: 2, deletions: 1, files: 3, binaryFiles: 1, baseCommit: base, scope: 'tracked' })
  expect(summary!.observedAt).toBeGreaterThan(0)
})

test('clean checkout is a valid zero and unavailable bases are not guessed', async () => {
  const { root, base } = fixture()
  expect(await readSessionChangeSummary(root, base)).toMatchObject({ additions: 0, deletions: 0, files: 0 })
  expect(await readSessionChangeSummary(root, undefined)).toBeUndefined()
  expect(await readSessionChangeSummary(root, '--bad-ref')).toBeUndefined()
  expect(await readSessionChangeSummary(root, 'f'.repeat(40))).toBeUndefined()
})
