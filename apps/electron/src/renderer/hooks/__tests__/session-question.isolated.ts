import { afterEach, describe, expect, it } from 'bun:test'
import * as React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { useSessionQuestion } from '../useSessionQuestion'
import type { PendingUserQuestion } from '@craft-agent/core/types'

const request: PendingUserQuestion = { requestId: 'old', sessionId: 'chat', createdAt: 1, questions: [{ question: 'Target?', options: [{ label: 'One' }, { label: 'Two' }] }] }
const originalWindow = globalThis.window
let tree: TestRenderer.ReactTestRenderer | undefined
let current: ReturnType<typeof useSessionQuestion>
afterEach(async () => {
  await act(async () => { tree?.unmount() })
  tree = undefined
  globalThis.window = originalWindow
})
async function harness() {
  const reads: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = []
  const responses: typeof reads = []
  let event = (_value: unknown) => {}
  let reconnect = () => {}
  globalThis.window = { electronAPI: {
    sessionCommand: (_session: string, command: { type: string }) => new Promise((resolve, reject) => {
      ;(command.type === 'getPendingQuestion' ? reads : responses).push({ resolve, reject })
    }),
    onSessionEvent: (listener: typeof event) => { event = listener; return () => {} },
    onReconnected: (listener: typeof reconnect) => { reconnect = listener; return () => {} },
  } } as unknown as Window & typeof globalThis
  function Harness() { current = useSessionQuestion('chat'); return null }
  await act(async () => { tree = TestRenderer.create(React.createElement(Harness)) })
  return { reads, responses, event: (value: unknown) => event(value), reconnect: () => reconnect() }
}
describe('live question recovery generations', () => {
  it('does not resurrect an older snapshot after a newer reconnect snapshot', async () => {
    const host = await harness()
    await act(async () => { host.reconnect() })
    await act(async () => { host.reads[1]!.resolve(null) })
    await act(async () => { host.reads[0]!.resolve(request) })
    expect(current.pending).toBeNull()
  })
  it('discards old read errors when a newer event supplies a request', async () => {
    const host = await harness()
    await act(async () => { host.event({ type: 'question_changed', sessionId: 'chat', request: { ...request, requestId: 'new' } }) })
    await act(async () => { host.reads[0]!.reject(new Error('Old read failed')) })
    expect(current.pending?.requestId).toBe('new')
    expect(current.error).toBeNull()
  })
  it('invalidates outstanding reads when an answer completes', async () => {
    const host = await harness()
    await act(async () => { host.reads[0]!.resolve(request) })
    let answer!: Promise<void>
    await act(async () => { answer = current.respond({ answers: [{ selected: ['One'] }] }); host.reconnect() })
    await act(async () => { host.responses[0]!.resolve(true); await answer })
    await act(async () => { host.reads[1]!.resolve(request) })
    expect(current.pending).toBeNull()
  })
  it('guards response-error recovery reads and errors against newer question events', async () => {
    const host = await harness()
    await act(async () => { host.reads[0]!.resolve(request) })
    let answer!: Promise<void>
    await act(async () => { answer = current.respond({ answers: [{ selected: ['One'] }] }) })
    await act(async () => { host.responses[0]!.reject(new Error('Try again')) })
    expect(current.error).toBe('Try again')
    await act(async () => { host.event({ type: 'question_changed', sessionId: 'chat', request: { ...request, requestId: 'new' } }) })
    await act(async () => { host.reads[1]!.resolve(request); await answer })
    expect(current.pending?.requestId).toBe('new')
    expect(current.error).toBeNull()
  })
  it('refreshes a surviving background question and its Skip action when foreground completes', async () => {
    const host = await harness()
    await act(async () => { host.reads[0]!.resolve({ ...request, cancelAction: 'stop' }) })
    await act(async () => { host.event({ type: 'complete', sessionId: 'chat' }) })
    expect(current.pending?.requestId).toBe('old')
    await act(async () => { host.reads[1]!.resolve({ ...request, cancelAction: 'skip' }) })
    expect(current.pending?.cancelAction).toBe('skip')
  })
})
