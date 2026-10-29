import { beforeEach, expect, test } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager'

let manager: any, session: any, events: any[]
beforeEach(() => {
  manager = new SessionManager(); events = []
  session = createManagedSession({ id: 'activity', name: 'Offline fixture' }, { id: 'w', name: 'Offline', rootPath: '/tmp/offline-activity' } as any, { messagesLoaded: true })
  manager.sessions.set(session.id, session)
  manager.persistSession = () => {}; manager.scheduleIdleRuntimeRelease = () => {}; manager.setSessionRecovery = () => {}
  manager.setEventSink((_channel: unknown, _target: unknown, event: unknown) => events.push(event))
})

test('runtime start and stop transitions reach the client without duplicate notifications', () => {
  manager.setProcessing(session, true)
  manager.setProcessing(session, true)
  manager.setProcessing(session, false)
  expect(events.filter(event => event.changes?.isProcessing !== undefined).map(event => event.changes.isProcessing)).toEqual([true, false])
})

test('a resumed background turn announces activity before its first output without a new owner prompt', async () => {
  let pending = true
  session.agent = { hasPendingBackgroundTurn: () => pending, resumeBackgroundTurn: async function* () { pending = false; yield { type: 'info', message: 'Background result' } } }
  manager.processEvent = async () => {}
  manager.onProcessingStopped = async () => manager.setProcessing(session, false)
  manager.resumeBackgroundTurn(session)
  expect(events.find(event => event.changes?.isProcessing === true)).toBeDefined()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(events.filter(event => event.changes?.isProcessing !== undefined).map(event => event.changes.isProcessing)).toEqual([true, false])
  expect(events.some(event => event.type === 'user_message')).toBe(false)
})

test('metadata counts current loaded history rather than an obsolete header count', () => {
  session.messageCount = 100
  session.messages = [{ id: 'one', role: 'user', content: 'kept', timestamp: 1 }]
  expect(manager.getSessions('w')[0].messageCount).toBe(1)
  session.messages.push({ id: 'two', role: 'assistant', content: 'new result', timestamp: 2 })
  expect(manager.getSessions('w')[0].messageCount).toBe(2)
  session.messages[0].isQueued = true
  expect(manager.getSessions('w')[0].queuedMessageCount).toBe(1)
  session.messages[0].isQueued = false
  expect(manager.getSessions('w')[0].queuedMessageCount).toBe(0)
  session.messagesLoaded = false
  expect(manager.getSessions('w')[0].messageCount).toBe(100)
  expect(manager.getSessions('w')[0].queuedMessageCount).toBeUndefined()
})
