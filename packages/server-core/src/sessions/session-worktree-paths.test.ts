import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { isSessionDirectoryInWorktree } from './session-worktree'

let root: string
let worktree: string
let child: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'session-worktree-paths-')))
  worktree = join(root, 'checkout')
  child = join(worktree, 'packages', 'app')
  mkdirSync(child, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('session directory references to a worktree', () => {
  it('recognizes the root and nested monorepo directories', async () => {
    expect(await isSessionDirectoryInWorktree(worktree, worktree)).toBe(true)
    expect(await isSessionDirectoryInWorktree(child, worktree)).toBe(true)
    expect(await isSessionDirectoryInWorktree(relative(process.cwd(), child), worktree)).toBe(true)
  })

  it('does not mistake neighboring prefixes or parent directories for descendants', async () => {
    const neighbor = `${worktree}-other`
    mkdirSync(neighbor)
    expect(await isSessionDirectoryInWorktree(neighbor, worktree)).toBe(false)
    expect(await isSessionDirectoryInWorktree(root, worktree)).toBe(false)
    expect(await isSessionDirectoryInWorktree(join(worktree, '..', 'outside'), worktree)).toBe(false)
    expect(await isSessionDirectoryInWorktree(undefined, worktree)).toBe(false)
    expect(await isSessionDirectoryInWorktree('', worktree)).toBe(false)
  })

  it('keeps lexical descendants protected after the directory or checkout disappears', async () => {
    rmSync(worktree, { recursive: true })
    expect(await isSessionDirectoryInWorktree(child, worktree)).toBe(true)
    expect(await isSessionDirectoryInWorktree(worktree, worktree)).toBe(true)
  })

  it('recognizes symlink aliases to the checkout and its subdirectories', async () => {
    const checkoutAlias = join(root, 'checkout-alias')
    const childAlias = join(root, 'child-alias')
    symlinkSync(worktree, checkoutAlias, 'dir')
    symlinkSync(child, childAlias, 'dir')
    expect(await isSessionDirectoryInWorktree(checkoutAlias, worktree)).toBe(true)
    expect(await isSessionDirectoryInWorktree(join(checkoutAlias, 'packages', 'app'), worktree)).toBe(true)
    expect(await isSessionDirectoryInWorktree(childAlias, worktree)).toBe(true)
    expect(await isSessionDirectoryInWorktree(child, checkoutAlias)).toBe(true)
  })

  it('recognizes missing descendants through an existing symlink alias', async () => {
    const alias = join(root, 'alias')
    symlinkSync(worktree, alias, 'dir')
    expect(await isSessionDirectoryInWorktree(join(alias, 'packages', 'removed', 'nested'), worktree)).toBe(true)
  })

  it('does not claim a symlink to an unrelated directory', async () => {
    const outside = join(root, 'outside')
    const alias = join(root, 'outside-alias')
    mkdirSync(outside)
    symlinkSync(outside, alias, 'dir')
    expect(await isSessionDirectoryInWorktree(alias, worktree)).toBe(false)
  })

  it('expands portable home paths without relying on their directory being present', async () => {
    const unique = `craft-worktree-path-${root.split('/').pop()}`
    const homeWorktree = join(homedir(), unique)
    expect(await isSessionDirectoryInWorktree(`~/${unique}/packages/app`, homeWorktree)).toBe(true)
    expect(await isSessionDirectoryInWorktree(`\${HOME}/${unique}/packages/app`, homeWorktree)).toBe(true)
  })
})
