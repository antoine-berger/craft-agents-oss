import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { createStore } from 'jotai'
import { panelStackAtom } from '../../atoms/panel-stack'
import { replaceLoadedSessionAtom, sessionAtomFamily, sessionMetaMapAtom } from '../../atoms/sessions'
import { confirmPendingSubmission } from '../../lib/session-submissions'
import { useStaleSessionRecovery } from '../useStaleSessionRecovery'

let store: ReturnType<typeof createStore>, root: ReturnType<typeof create> | undefined
let clock: number, timer: () => void, original: Record<string, PropertyDescriptor | undefined>, oldNow: typeof Date.now
let remote: any, local: any, read: ReturnType<typeof mock>, reload: ReturnType<typeof mock>
let activity: ReturnType<typeof useStaleSessionRecovery>['trackSessionActivity']
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function Probe() { activity = useStaleSessionRecovery({ store, refreshSessionFromServer: reload }).trackSessionActivity; return null }
const mount = async () => { await act(async () => { root = create(<Probe />) }) }
const tick = async () => { clock += 30000; await act(async () => { timer(); await Promise.resolve() }) }
beforeEach(() => {
  store = createStore(); clock = 1_800_000_000_000; oldNow = Date.now; Date.now = () => clock
  local = { id: 's', workspaceId: 'w', isProcessing: false, messages: [{ id: 'u', role: 'user', content: 'question', timestamp: 1 }], messageCount: 1 }
  remote = { ...local, messages: [...local.messages] }
  store.set(replaceLoadedSessionAtom, local)
  store.set(panelStackAtom, [{ id: 'panel', route: 'allSessions/session/s', proportion: 1, panelType: 'session', laneId: 'main' }])
  read = mock(async () => [{ ...remote, messages: [], messageCount: remote.messages.length,
    queuedMessageCount: remote.messages.filter((message: any) => message.role === 'user' && message.isQueued).length }])
  reload = mock(async (_id: string, canApply?: () => boolean) => {
    if (canApply && !canApply()) return 'preserved_stale_messages' as const
    store.set(replaceLoadedSessionAtom, { ...remote })
    return 'refreshed' as const
  })
  original = Object.fromEntries(['window', 'document', 'setInterval', 'clearInterval'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, {
    window: Object.assign(new EventTarget(), { electronAPI: { getSessions: (...args: any[]) => read(...args) } }),
    document: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
    setInterval: (cb: () => void) => { timer = cb; return 1 }, clearInterval: () => {},
  })
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount()); root = undefined; Date.now = oldNow
  for (const [key, descriptor] of Object.entries(original)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key]
  }
})

test('recovers a visible chat that looks idle while the server is running', async () => {
  remote.isProcessing = true
  await mount(); await tick()
  expect(reload).toHaveBeenCalledTimes(1)
  expect(store.get(sessionAtomFamily('s'))?.isProcessing).toBe(true)
})

test('recovers a missed final answer without restarting or repeatedly fetching unchanged history', async () => {
  remote.messages.push({ id: 'answer', role: 'assistant', content: 'done', timestamp: 2 })
  remote.lastFinalMessageId = 'answer'
  await mount(); await tick(); await tick()
  expect(read).toHaveBeenCalledTimes(2)
  expect(reload).toHaveBeenCalledTimes(1)
  expect(store.get(sessionAtomFamily('s'))?.messages.at(-1)?.id).toBe('answer')
})

test('recovers a missed queue removal but preserves an unacknowledged local submission', async () => {
  const queued = { id: 'queue', role: 'user', content: 'removed on server', timestamp: 2, isQueued: true }
  store.set(replaceLoadedSessionAtom, { ...local, messages: [...local.messages, queued] })
  await mount(); await tick()
  expect(reload).toHaveBeenCalledTimes(1)
  expect(store.get(sessionAtomFamily('s'))?.messages).toHaveLength(1)
  store.set(replaceLoadedSessionAtom, { ...local, isProcessing: true, messages: [...local.messages, { ...queued, isPending: true }] })
  await tick()
  expect(reload).toHaveBeenCalledTimes(1)
  expect(store.get(sessionAtomFamily('s'))?.messages).toHaveLength(2)
  const pending = store.get(sessionAtomFamily('s'))!
  store.set(replaceLoadedSessionAtom, { ...pending, messages: confirmPendingSubmission(pending.messages, queued.id) })
  await tick()
  expect(reload).toHaveBeenCalledTimes(2)
  expect(store.get(sessionAtomFamily('s'))?.messages).toHaveLength(1)
})

test('ignores metadata replies superseded by live events', async () => {
  const pending = deferred<any[]>()
  read.mockImplementation(() => pending.promise)
  await mount(); await tick()
  activity('s')
  await act(async () => { pending.resolve([{ ...remote, isProcessing: true }]) })
  expect(reload).not.toHaveBeenCalled()
})

test('recovers missed queue acceptance or replay even when history length and processing state match', async () => {
  store.set(replaceLoadedSessionAtom, { ...local, messages: [{ ...local.messages[0], isQueued: true }] })
  await mount(); await tick()
  expect(reload).toHaveBeenCalledTimes(1)
  expect(store.get(sessionAtomFamily('s'))?.messages[0]?.isQueued).not.toBe(true)
})

test('a live event during a full transcript request prevents applying its older reply', async () => {
  const pending = deferred<void>(); let allowed: (() => boolean) | undefined
  remote.isProcessing = true
  reload.mockImplementation(async (_id: string, canApply?: () => boolean) => {
    allowed = canApply; await pending.promise
    return canApply?.() ? 'refreshed' : 'preserved_stale_messages'
  })
  await mount(); await tick()
  expect(allowed?.()).toBe(true)
  activity('s')
  expect(allowed?.()).toBe(false)
  await act(async () => { pending.resolve() })
  expect(store.get(sessionAtomFamily('s'))).toBe(local)
})

test('hidden app and offscreen or archived chats do not fetch full history', async () => {
  remote.isProcessing = true
  await mount(); Object.assign(document, { visibilityState: 'hidden' }); await tick()
  expect(read).not.toHaveBeenCalled()
  Object.assign(document, { visibilityState: 'visible' }); store.set(panelStackAtom, []); await tick()
  expect(read).toHaveBeenCalledTimes(1)
  expect(reload).not.toHaveBeenCalled()
  store.set(panelStackAtom, [{ id: 'panel', route: 'allSessions/session/s', proportion: 1, panelType: 'session', laneId: 'main' }])
  store.set(replaceLoadedSessionAtom, { ...local, isArchived: true }); await tick()
  expect(reload).not.toHaveBeenCalled()
})

test('offscreen runtime metadata is reconciled without downloading its transcript', async () => {
  store.set(replaceLoadedSessionAtom, { ...local, isProcessing: true })
  store.set(panelStackAtom, [])
  await mount(); await tick()
  expect(store.get(sessionMetaMapAtom).get('s')?.isProcessing).toBe(false)
  expect(reload).not.toHaveBeenCalled()
  expect(store.get(sessionAtomFamily('s'))?.messages).toBe(local.messages)
})

test('offscreen live activity supersedes an older idle metadata response', async () => {
  const pending = deferred<any[]>()
  read.mockImplementation(() => pending.promise)
  store.set(replaceLoadedSessionAtom, { ...local, isProcessing: true })
  store.set(panelStackAtom, [])
  await mount(); await tick()
  activity('s')
  await act(async () => { pending.resolve([{ ...remote, isProcessing: false }]) })
  expect(store.get(sessionMetaMapAtom).get('s')?.isProcessing).toBe(true)
  expect(reload).not.toHaveBeenCalled()
})

test('focus bursts coalesce and hiding or unmounting during a request cancels recovery', async () => {
  const pending = deferred<any[]>(); read.mockImplementation(() => pending.promise)
  await mount()
  await act(async () => { for (let i = 0; i < 10; i++) window.dispatchEvent(new Event('focus')) })
  expect(read).toHaveBeenCalledTimes(1)
  Object.assign(document, { visibilityState: 'hidden' })
  await act(async () => { pending.resolve([{ ...remote, isProcessing: true }]) })
  expect(reload).not.toHaveBeenCalled()
  const next = deferred<any[]>(); read.mockImplementation(() => next.promise)
  Object.assign(document, { visibilityState: 'visible' }); await tick()
  await act(async () => root!.unmount()); root = undefined
  await act(async () => { next.resolve([{ ...remote, isProcessing: true }]) })
  expect(reload).not.toHaveBeenCalled()
})
