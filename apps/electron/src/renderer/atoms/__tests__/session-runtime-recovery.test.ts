import { afterEach, describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import type { Message, Session } from '../../../shared/types'
import {
  sessionAtomFamily,
  sessionMetaMapAtom,
  sessionIdsAtom,
  loadedSessionsAtom,
  ensureSessionMessagesLoadedAtom,
  forceSessionMessagesReloadAtom,
  refreshSessionsMetadataAtom,
  initializeSessionsAtom,
  replaceLoadedSessionAtom,
  backgroundTasksAtomFamily,
} from '../sessions'

function msg(id: string, role: Message['role'] = 'user'): Message {
  return {
    id,
    role,
    content: `content:${id}`,
    timestamp: Date.now(),
  }
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id ?? 'session-1',
    workspaceId: overrides.workspaceId ?? 'workspace-1',
    messages: overrides.messages ?? [],
    permissionMode: overrides.permissionMode ?? 'ask',
    supportsBranching: overrides.supportsBranching ?? true,
    ...overrides,
  } as Session
}

describe('session runtime recovery', () => {
  const originalWindow = globalThis.window
  afterEach(() => { globalThis.window = originalWindow })
  const task = { id: 'agent', type: 'agent' as const, isSubagent: true, toolUseId: 'tool', startTime: 100, elapsedSeconds: 12, lastSignalAt: 200, status: 'running' as const }

  it('hydrates live task chips on reopen and stale reconnect, including an authoritative empty list', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [makeSession({ backgroundTasks: [task] })])
    expect(store.get(backgroundTasksAtomFamily('session-1'))).toEqual([task])
    store.set(refreshSessionsMetadataAtom, { sessions: [makeSession({ backgroundTasks: [] })], loadedSessionIds: new Set<string>() })
    expect(store.get(backgroundTasksAtomFamily('session-1'))).toEqual([])
    store.set(replaceLoadedSessionAtom, makeSession({ backgroundTasks: [task] }))
    expect(store.get(backgroundTasksAtomFamily('session-1'))).toEqual([task])
    store.set(replaceLoadedSessionAtom, makeSession()) // Backward compatibility with older servers.
    expect(store.get(backgroundTasksAtomFamily('session-1'))).toEqual([task])
  })

  it('replaces request-window deltas with the full server prefix while preserving optimistic UI fields', async () => {
    const store = createStore()
    let respond!: (s: Session) => void
    globalThis.window = { electronAPI: { getSessionMessages: () => new Promise<Session>(resolve => { respond = resolve }) } } as unknown as typeof window
    store.set(initializeSessionsAtom, [makeSession({ isProcessing: true, hasUnread: false, isFlagged: true })])
    const loading = store.set(ensureSessionMessagesLoadedAtom, 'session-1')
    store.set(sessionAtomFamily('session-1'), makeSession({ isProcessing: true, hasUnread: false, isFlagged: true, messages: [{ ...msg('live', 'assistant'), content: 'suffix', isStreaming: true, turnId: 'turn' }] }))
    respond(makeSession({ isProcessing: true, hasUnread: true, isFlagged: false, backgroundTasks: [task], messages: [{ ...msg('snapshot', 'assistant'), content: 'prefix suffix', isStreaming: true, turnId: 'turn' }] }))
    await loading
    const session = store.get(sessionAtomFamily('session-1'))!
    expect(session.messages.map(m => m.content)).toEqual(['prefix suffix'])
    expect(store.get(sessionMetaMapAtom).get('session-1')?.lastFinalMessageId).toBeUndefined()
    expect(session.hasUnread).toBe(false)
    expect(session.isFlagged).toBe(true)
    expect(store.get(backgroundTasksAtomFamily('session-1'))).toEqual([task])
  })
})
