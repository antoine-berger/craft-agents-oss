import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionFilePath } from '@craft-agent/shared/sessions/storage'
import { SessionManager, createManagedSession } from './SessionManager'

describe('archived chats are execution-locked', () => {
  let root: string
  let manager: SessionManager
  let internal: any
  let session: ReturnType<typeof createManagedSession>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'craft-archive-lock-'))
    manager = new SessionManager()
    internal = manager as any
    manager.setEventSink(() => {})
    internal.getBrowserPaneManagerForSession = () => null
    session = createManagedSession({ id: 'chat', name: 'Keep this history' },
      { id: 'workspace', name: 'Fixture', rootPath: root, createdAt: 1 } as any,
      { messagesLoaded: true })
    session.messages.push({ id: 'existing', role: 'user', content: 'preserve me', timestamp: 1 })
    internal.sessions.set(session.id, session)
  })

  afterEach(async () => {
    if (session.autoRetryTimer) clearTimeout(session.autoRetryTimer)
    await manager.flushSession(session.id)
    rmSync(root, { recursive: true, force: true })
  })

  it('hard-stops the runtime and cancels queued/retry/background work without deleting messages or worktree data', async () => {
    const calls: string[] = []
    session.isProcessing = true
    session.agent = {
      forceAbort: () => calls.push('hard-abort'),
      stopTurn: () => { throw new Error('Soft stop must not preserve background work') },
      dispose: () => calls.push('dispose'),
    } as any
    session.messages.push({ id: 'queued', role: 'user', content: 'accepted follow-up', timestamp: 2, isQueued: true })
    session.messageQueue.push({ message: 'accepted follow-up', messageId: 'queued' })
    session.pendingActivationResend = 'automatic retry'
    session.autoRetryPending = { content: 'automatic retry', deadlineMs: Date.now() + 1000, committed: false }
    session.autoRetryTimer = setTimeout(() => { throw new Error('Archived retry fired') }, 500)
    session.backgroundTaskRegistry.set('bg', { status: 'running' } as any)
    session.worktree = { repositoryPath: '/preserved/repository', cleanupOnArchive: false }

    await manager.archiveSession(session.id)
    expect(calls).toEqual(['hard-abort', 'dispose'])
    expect(session.isArchived).toBe(true)
    expect(session.isProcessing).toBe(false)
    expect(session.agent).toBeNull()
    expect(session.messageQueue).toHaveLength(0)
    expect(session.messages.map(message => message.content)).toEqual(['preserve me', 'accepted follow-up'])
    expect(session.messages[1]!.isQueued).toBe(false)
    expect(session.autoRetryTimer).toBeUndefined()
    expect(session.pendingActivationResend).toBeUndefined()
    expect(session.backgroundTaskRegistry.get('bg')!.status).toBe('stopped')
    const lines = readFileSync(getSessionFilePath(root, session.id), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(lines[0].isArchived).toBe(true)
    expect(lines[0].worktree.repositoryPath).toBe('/preserved/repository')
    expect(lines.slice(1).map(message => message.content)).toEqual(['preserve me', 'accepted follow-up'])
  })

  it('rejects normal, hidden, queued and auth-retry sends before accepting or persisting a prompt', async () => {
    await manager.archiveSession(session.id)
    const file = getSessionFilePath(root, session.id)
    const before = readFileSync(file, 'utf8')
    for (const options of [undefined, { hidden: true }]) {
      await expect(manager.sendMessage(session.id, 'forbidden', [], [], options)).rejects.toThrow('archived')
    }
    await expect(manager.sendMessage(session.id, 'auth retry', [], [], undefined, undefined, true)).rejects.toThrow('archived')
    await expect(internal.sendMessageInternal(session.id, 'queued replay', [], [], undefined, 'existing')).rejects.toThrow('archived')
    expect(manager.wakeIdleSessionWithNotice(session.id, 'PR auto-fix')).toBe(false)
    await expect(manager.spawnIndependentSession(session.id, { prompt: 'escape archive' })).rejects.toThrow('archived')
    await expect(manager.restoreSessionCheckpoint(session.id, 'old-checkpoint')).rejects.toThrow('archived')
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('keeps the owner restore path, without replaying cancelled prompts', async () => {
    session.messages[0]!.isQueued = true
    session.messageQueue.push({ message: 'old queued prompt', messageId: 'existing' })
    await manager.archiveSession(session.id)
    await manager.unarchiveSession(session.id)
    expect(session.isArchived).toBe(false)
    expect(session.messageQueue).toHaveLength(0)
    expect(session.isProcessing).toBe(false)
    // Exercise normal acceptance without constructing an LLM backend.
    session.isProcessing = true
    await manager.sendMessage(session.id, 'new owner prompt')
    expect(session.messageQueue.map(item => item.message)).toEqual(['new owner prompt'])
  })

  it('does not revive a send suspended before archive, even if the owner restores meanwhile', async () => {
    const gate = Promise.withResolvers<void>()
    internal.assertNoCheckpointRestore = () => gate.promise
    const sending = manager.sendMessage(session.id, 'stale send').catch(error => error)
    await manager.archiveSession(session.id)
    await manager.unarchiveSession(session.id)
    gate.resolve()
    expect((await sending).name).toBe('AbortError')
    expect(session.messages.map(message => message.content)).toEqual(['preserve me'])
  })

  it('does not advance a workflow through an old completion suspended across archive/restore', async () => {
    const gate = Promise.withResolvers<void>()
    const events: unknown[] = []
    let first = true
    manager.onSessionComplete(event => events.push(event))
    internal.getBrowserPaneManagerForSession = () => {
      if (!first) return null
      first = false
      return { clearVisualsForSession: () => gate.promise }
    }
    const completing = internal.onProcessingStopped(session.id, 'complete')
    await manager.archiveSession(session.id)
    await manager.unarchiveSession(session.id)
    gate.resolve()
    await completing
    expect(events).toHaveLength(0)
  })

  it('waits for in-flight initialization before allowing owner restore and never constructs its runtime', async () => {
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    let constructed = false
    internal.syncAutomaticSessionSources = async () => { entered.resolve(); await gate.promise }
    internal.getOrCreatePreparedAgent = async () => { constructed = true; return {} }
    const preparing = internal.getOrCreateAgent(session).catch((error: Error) => error)
    await entered.promise
    const archiving = manager.archiveSession(session.id)
    const restoring = manager.unarchiveSession(session.id)
    await Promise.resolve()
    expect(session.isArchived).toBe(true)
    gate.resolve()
    expect((await preparing).message).toContain('archived')
    await archiving
    await restoring
    expect(constructed).toBe(false)
    expect(session.isArchived).toBe(false)
    expect(session.agent).toBeNull()
  })

  it('never unlocks a chat whose runtime failed to stop; the stop can be retried', async () => {
    let fail = true
    session.agent = { forceAbort: () => {}, dispose: () => { if (fail) throw new Error('stop failed') } } as any
    await expect(manager.archiveSession(session.id)).rejects.toThrow('could not be fully stopped')
    await expect(manager.unarchiveSession(session.id)).rejects.toThrow('not fully stopped')
    await expect(manager.sendMessage(session.id, 'still forbidden')).rejects.toThrow('archived')
    fail = false
    await manager.archiveSession(session.id)
    await manager.unarchiveSession(session.id)
    expect(session.isArchived).toBe(false)
  })

  it('does not let a scheduled auth retry erase history after archiving', async () => {
    session.lastSentMessage = 'preserve me'
    expect(internal.attemptAuthRetry(session.id, session, 'workspace')).toBe(true)
    await manager.archiveSession(session.id)
    await new Promise(resolve => setImmediate(resolve))
    expect(session.messages.map(message => message.content)).toEqual(['preserve me'])
    expect(session.authRetryInProgress).toBe(false)
  })

  it('does not replay crash-recovered queued messages in a cold archived chat or when restoring it', async () => {
    session.isArchived = true
    session.messages[0]!.isQueued = true
    internal.persistSession(session)
    await manager.flushSession(session.id)
    const cold = createManagedSession({ id: session.id, isArchived: true }, session.workspace, { messagesLoaded: false })
    internal.sessions.set(cold.id, cold)
    session = cold
    await manager.getSession(cold.id)
    await new Promise(resolve => setImmediate(resolve))
    expect(cold.messageQueue).toHaveLength(0)
    await manager.unarchiveSession(cold.id)
    expect(cold.messageQueue).toHaveLength(0)
    expect(cold.messages[0]!.isQueued).toBe(false)
  })
})
