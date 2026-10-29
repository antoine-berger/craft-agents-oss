import { expect, test } from 'bun:test'
import { registerSessionsHandlers } from '@craft-agent/server-core/handlers/rpc/sessions'
import { RPC_CHANNELS, type FileAttachment } from '@craft-agent/shared/protocol'
import type { SessionDraft } from '@craft-agent/shared/config'
import { SessionSubmissions, SubmissionCancelled, recoverSubmissionDraft, canChooseSubmissionRepository, discardPendingSubmission, mergeHydratedAttachments } from '../session-submissions'
import { CONTENT_PERSIST_CAP } from '../drafts'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve() }
const file = (name: string): FileAttachment => ({ path: name, name, type: 'image', mimeType: 'image/png', size: 3, base64: 'AAAA' })

/** This invokes the real RPC handler, whose response ends at onAck while its AI Promise remains open. */
function realAckHandler() {
  const handlers = new Map<string, (...args: any[]) => any>()
  const started: string[] = []
  const acks = new Map<string, () => void>()
  const ai = new Map<string, ReturnType<typeof deferred<void>>>()
  registerSessionsHandlers({ handle: (channel: string, handler: any) => handlers.set(channel, handler) } as any, {
    sessionManager: { sendMessage: async (_session: string, message: string, _attachments: unknown, _stored: unknown, _options: unknown,
      _turn: unknown, _parent: unknown, onAck: (id: string) => void) => {
      started.push(message); acks.set(message, () => onAck(`persisted-${message}`))
      const running = deferred<void>(); ai.set(message, running); await running.promise
    } }, platform: { logger: { error: () => {} } },
  } as any)
  return { started, ack: (text: string) => acks.get(text)!(), ai,
    send: (session: string, text: string) => handlers.get(RPC_CHANNELS.sessions.SEND_MESSAGE)!({ clientId: 'test' }, session, text) }
}

test('a slow permission/upload head holds FIFO through the real durable RPC ACK, never until AI completion; other sessions stay independent', async () => {
  const queue = new SessionSubmissions(), permission = deferred<void>(), upload = deferred<void>(), rpc = realAckHandler()
  const b = queue.run('one', async check => { check(); await permission.promise; check(); await upload.promise; check(); return rpc.send('one', 'B') })
  const c = queue.run('one', async check => { check(); return rpc.send('one', 'C') })
  const d = queue.run('two', async check => { check(); return rpc.send('two', 'D') })
  await flush(); expect(rpc.started).toEqual(['D'])
  rpc.ack('D'); await d
  permission.resolve(); await flush(); expect(rpc.started).toEqual(['D'])
  upload.resolve(); await flush(); expect(rpc.started).toEqual(['D', 'B'])
  rpc.ack('B'); expect(await b).toEqual({ accepted: true, messageId: 'persisted-B' })
  await flush(); expect(rpc.started).toEqual(['D', 'B', 'C'])
  rpc.ack('C'); await c
  // Nothing resolved these model-turn promises: only the durable user-message ACK released the lane.
  expect(rpc.ai.size).toBe(3)
  for (const running of rpc.ai.values()) running.resolve()
})

test('Stop during upload cancels the old head and followers, restores text/PJ in order, and does not cancel new submissions', async () => {
  const queue = new SessionSubmissions(), upload = deferred<void>(), delivered: string[] = []
  let draft: SessionDraft | undefined = { text: 'New draft', attachments: [{ path: '/existing.png', name: 'existing.png' }] }
  const submit = (text: string, wait?: Promise<void>) => queue.run('one', async check => {
    try { check(); if (wait) await wait; check(); delivered.push(text) }
    catch (error) {
      if (!(error instanceof SubmissionCancelled)) throw error
      draft = recoverSubmissionDraft(draft, text, [file(`${text}.png`)])
    }
  })
  const b = submit('B', upload.promise), c = submit('C'); await flush()
  queue.cancel('one') // synchronous local Stop, before cancelProcessing travels to the backend
  const d = submit('D'); upload.resolve(); await Promise.all([b, c, d])
  expect(delivered).toEqual(['D'])
  expect(draft?.text).toBe('New draft\n\nB\n\nC')
  expect(draft?.attachments?.map(value => value.name)).toEqual(['existing.png', 'B.png', 'C.png'])
  expect(draft?.attachments?.[1]?.content?.base64).toBe('AAAA')
})

test('archive followed by unarchive during permission preparation cannot revive old prompts', async () => {
  const queue = new SessionSubmissions(), permission = deferred<void>()
  let stores = 0, sends = 0, cancelled = 0
  const send = queue.run('one', async check => { try { check(); await permission.promise; check(); stores++; sends++ }
    catch (error) { expect(error).toBeInstanceOf(SubmissionCancelled); cancelled++ } })
  await flush(); queue.cancel('one') // archive invalidates even if metadata becomes unarchived before permission ACK
  permission.resolve(); await send
  expect({ stores, sends, cancelled }).toEqual({ stores: 0, sends: 0, cancelled: 1 })
})

test('a failed preparation can invalidate followers without poisoning later submissions', async () => {
  const queue = new SessionSubmissions(), failed = deferred<void>(), delivered: string[] = []
  const b = queue.run('one', async check => { check(); await failed.promise; queue.cancel('one'); throw new Error('Upload failed') })
  const c = queue.run('one', async check => { check(); delivered.push('C') })
  const bError = b.catch(error => error.message), cError = c.catch(error => error)
  failed.resolve(); expect(await bError).toBe('Upload failed'); expect(await cError).toBeInstanceOf(SubmissionCancelled)
  await queue.run('one', async check => { check(); delivered.push('D') })
  expect(delivered).toEqual(['D'])
})

test('emergency recovery keeps oversized paste bytes and existing draft attachments instead of dropping them', () => {
  const text = 'x'.repeat(CONTENT_PERSIST_CAP + 1)
  const draft = recoverSubmissionDraft({ text: 'Typed now', attachments: [{ path: '/a.txt', name: 'a.txt' }] }, 'Cancelled',
    [{ path: 'pasted.txt', name: 'pasted.txt', type: 'text', mimeType: 'text/plain', size: text.length, text }])
  expect(draft.text).toBe('Typed now\n\nCancelled')
  expect(draft.attachments).toHaveLength(2)
  expect(draft.attachments![1]!.content!.text === text).toBe(true)
})

test('follow-ups never redefine the repository while the worktree is pending after the first durable ACK', () => {
  expect(canChooseSubmissionRepository({ isProcessing: false, messages: [] })).toBe(true)
  expect(canChooseSubmissionRepository({ isProcessing: true, messages: [] })).toBe(false)
  expect(canChooseSubmissionRepository({ isProcessing: true, messages: [{ role: 'user' }] })).toBe(false)
  expect(canChooseSubmissionRepository({ isProcessing: false, messages: [{ role: 'user' }] })).toBe(false)
})

test('a pre-ACK rejected attempt is removed so its first repository submission can be retried, while confirmed users remain', () => {
  const pending: any = { id: 'optimistic', role: 'user', content: 'B', timestamp: 1, isPending: true }
  const messages = discardPendingSubmission([pending], 'optimistic')
  expect(messages).toEqual([])
  expect(canChooseSubmissionRepository({ isProcessing: false, messages })).toBe(true)
  expect(discardPendingSubmission([{ ...pending, isPending: false }], 'optimistic')).toHaveLength(1)
  expect(discardPendingSubmission([{ ...pending, id: 'canonical' }], 'optimistic')).toHaveLength(1)
})

test('late attachment hydration preserves restored bytes and existing draft files without duplicating them', () => {
  const old = file('existing.png'), restored = file('B.png')
  expect(mergeHydratedAttachments([old], [restored]).map(value => value.name)).toEqual(['existing.png', 'B.png'])
  expect(mergeHydratedAttachments([old, restored], [restored])).toHaveLength(2)
  const differentBytes = { ...restored, base64: 'BBBB' }
  expect(mergeHydratedAttachments([restored], [differentBytes])).toHaveLength(2)
})
