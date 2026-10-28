import { expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let entered!: () => void
let release!: () => void
const started = new Promise<void>(resolve => { entered = resolve })
const read = new Promise<void>(resolve => { release = resolve })
let reads = 0
mock.module('../services/repositories/change-summary', () => ({
  async readSessionChangeSummary(_directory: string, baseCommit: string) {
    reads++; entered(); await read
    return { additions: 3, deletions: 1, files: 1, binaryFiles: 0, baseCommit, observedAt: 1, scope: 'tracked' }
  },
}))
const { SessionManager, createManagedSession } = await import('./SessionManager')

test('a pending Git count cannot publish after manager cleanup or restart another count', async () => {
  const root = mkdtempSync(join(tmpdir(), 'craft-summary-dispose-'))
  const manager = new SessionManager()
  const internal = manager as any
  const chat = createManagedSession({ id: 'summary', workingDirectory: root,
    worktree: { repositoryPath: root, owned: { baseCommit: 'a'.repeat(40), path: root } } as any },
  { id: 'fixture', name: 'Fixture', rootPath: root, createdAt: 1 } as any, { messagesLoaded: true })
  internal.sessions.set(chat.id, chat)
  let persisted = 0, published = 0
  internal.persistSession = () => { persisted++ }
  manager.setEventSink(() => { published++ })
  const refreshing = internal.refreshSessionChangeSummary(chat.id)
  try {
    await started
    manager.cleanup()
    release()
    await refreshing
    await internal.refreshSessionChangeSummary(chat.id)
    expect(reads).toBe(1)
    expect(chat.worktree?.changeSummary).toBeUndefined()
    expect(persisted).toBe(0)
    expect(published).toBe(0)
  } finally {
    release(); await refreshing
    rmSync(root, { recursive: true, force: true })
  }
})
