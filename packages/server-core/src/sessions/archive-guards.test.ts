import { describe, it, expect } from 'bun:test'
import { validateArchiveTarget } from './archive-guards.ts'

describe('validateArchiveTarget (archive_session guards)', () => {
  const WS = 'ws-1'
  const idle = { workspaceId: WS, isProcessing: false }
  const busy = { workspaceId: WS, isProcessing: true }

  it('allows archiving an idle session in the same workspace', () => {
    expect(validateArchiveTarget(idle, WS, 's-2', true)).toBeNull()
  })

  it('reserves unarchiving an idle session to the owner', () => {
    expect(validateArchiveTarget(idle, WS, 's-2', false)).toContain('Only the owner')
  })

  it('rejects an unknown target', () => {
    expect(validateArchiveTarget(undefined, WS, 'ghost', true)).toContain('not found in this workspace')
  })

  it('rejects a cross-workspace target with the same opaque message as unknown', () => {
    const foreign = { workspaceId: 'ws-OTHER', isProcessing: false }
    const crossWs = validateArchiveTarget(foreign, WS, 's-3', true)
    const unknown = validateArchiveTarget(undefined, WS, 's-3', true)
    expect(crossWs).toContain('not found in this workspace')
    expect(crossWs).toBe(unknown)
  })

  it('allows archiving a running session so the server can stop it', () => {
    expect(validateArchiveTarget(busy, WS, 's-4', true)).toBeNull()
  })

  it('never lets an agent unarchive, including a running target', () => {
    expect(validateArchiveTarget(busy, WS, 's-4', false)).toContain('Only the owner')
  })
})
