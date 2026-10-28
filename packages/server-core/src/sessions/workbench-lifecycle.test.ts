import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from './SessionManager'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

let manager: SessionManager
let internal: any
let root: string
let chat: ReturnType<typeof createManagedSession>
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-workbench-'))
  manager = new SessionManager()
  internal = manager as any
  manager.setEventSink(() => {})
  internal.getBrowserPaneManagerForSession = () => null
  chat = createManagedSession({ id: 'chat', workingDirectory: root },
    { id: 'fixture', name: 'Fixture', rootPath: root, createdAt: 1 } as any, { messagesLoaded: true })
  internal.sessions.set(chat.id, chat)
})
afterEach(async () => {
  await manager.flushSession(chat.id)
  manager.cleanup()
  rmSync(root, { recursive: true, force: true })
})

test('archiving an imported checkout drains accepted saves and refuses further writes', async () => {
  const entered = deferred(), release = deferred(), stopping = deferred()
  const order: string[] = []
  manager.registerWorktreeResource({ hasRunningSession: () => false, stopSession: () => { stopping.resolve() }, dispose() {} })
  const save = manager.withSessionWorktreeWrite(chat.id, async () => {
    entered.resolve()
    await release.promise
    order.push('save')
  })
  await entered.promise
  let archived = false
  const archive = manager.archiveSession(chat.id).then(() => { archived = true; order.push('archive') })
  try {
    await stopping.promise
    expect(archived).toBe(false)
    await expect(manager.withSessionWorktreeWrite(chat.id, async () => {})).rejects.toThrow('archived')
  } finally { release.resolve(); await Promise.all([save, archive]) }
  expect(order).toEqual(['save', 'archive'])
})

test('a running terminal in another chat sharing the checkout blocks restoration', async () => {
  chat.worktree = { repositoryPath: root, owned: { path: root } } as any
  const sibling = createManagedSession({ id: 'sibling', workingDirectory: root }, chat.workspace, { messagesLoaded: true })
  internal.sessions.set(sibling.id, sibling)
  let running = true
  manager.registerWorktreeResource({ hasRunningSession: id => running && id === sibling.id, stopSession() { running = false }, dispose() {} })
  await expect(internal.assertCheckpointIdle(chat)).rejects.toThrow('Stop running')
  running = false
  await internal.assertCheckpointIdle(chat)
})

test('a failed terminal stop keeps an archived chat locked until a successful retry', async () => {
  let fails = true
  manager.registerWorktreeResource({ hasRunningSession: () => true,
    stopSession() { if (fails) throw new Error('Terminal still running') }, dispose() {} })
  await expect(manager.archiveSession(chat.id)).rejects.toThrow('Terminal still running')
  expect(chat.isArchived).toBe(true)
  await expect(manager.unarchiveSession(chat.id)).rejects.toThrow()
  fails = false
  await manager.archiveSession(chat.id)
  await manager.unarchiveSession(chat.id)
  expect(chat.isArchived).toBe(false)
})
