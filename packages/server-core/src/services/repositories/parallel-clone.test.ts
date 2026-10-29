import { expect, it, spyOn } from 'bun:test'
import * as childProcess from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveWorktreeRepository } from './worktree'
it('initializes a shared repository once for concurrent new chats without sharing their worktrees', async () => {
  const root = mkdtempSync(join(tmpdir(), 'craft-parallel-clone-'))
  const original = childProcess.execFile
  let clones = 0
  const hook = spyOn(childProcess, 'execFile').mockImplementation(((command: string, args: string[], options: unknown, callback: Function) => {
    if (command !== 'gh') return (original as any)(command, args, options, callback)
    clones++
    const target = args[3]!
    setImmediate(() => {
      if (existsSync(target)) { callback(Error('already exists'), '', 'already exists'); return }
      mkdirSync(target)
      childProcess.execFileSync('git', ['init', target], { stdio: 'ignore' })
      childProcess.execFileSync('git', ['-C', target, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git'])
      callback(null, '', '')
    })
    return {} as any
  }) as any)
  try {
    const [first, second] = await Promise.all([
      resolveWorktreeRepository({ cloneNameWithOwner: 'owner/repo' }, root),
      resolveWorktreeRepository({ cloneNameWithOwner: 'owner/repo' }, root),
    ])
    expect(clones).toBe(1)
    expect(first.gitDir).toBe(second.gitDir)
    expect(first.cloned).toBe(true); expect(second.cloned).toBe(false)
  } finally { hook.mockRestore(); rmSync(root, { recursive: true, force: true }) }
})
