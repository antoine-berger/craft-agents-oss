import { expect, it, mock } from 'bun:test'
import * as sdk from '@anthropic-ai/claude-agent-sdk'

let launchedOptions: any
mock.module('@anthropic-ai/claude-agent-sdk', () => ({ ...sdk, query: ({ options }: any) => {
  launchedOptions = options
  return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }
} }))
const { ClaudeAgent } = await import('../claude-agent')
const { createPushableInputStream } = await import('../backend/claude/persistent-input')

it('keeps Stop bound to the actual new query after the old query exits during a native drain', async () => {
  const previous = new AbortController()
  const prepared = new AbortController()
  const channel = createPushableInputStream(); channel.end()
  const agent: any = Object.assign(Object.create(ClaudeAgent.prototype), {
    config: { workspace: { rootPath: '/tmp' }, session: { id: 'controller-test' } },
    currentQuery: {}, persistentInput: createPushableInputStream(), persistentIterator: {},
    persistentAbortController: previous, currentQueryAbortController: prepared,
    pendingBackgroundTurns: [{ channel, state: { aborted: false }, userMessage: 'prior request' }],
    eventAdapter: { flushPending: () => null }, pendingSteers: { pause: () => {} }, debug: () => {},
  })
  agent.drainSdkTurn = async function* () {
    this.teardownPersistentQuery('consumer-exit')
    yield { type: 'complete' }
    return { handedOff: false }
  }
  for await (const _event of agent.drainBackgroundTurn(true)) {}
  await agent.beginPersistentTurn({ type: 'user', message: { role: 'user', content: 'next' } }, { abortController: prepared }, {})
  expect(agent.persistentAbortController).toBe(launchedOptions.abortController)
  expect(prepared.signal.aborted).toBe(false)
  agent.forceAbort()
  expect(prepared.signal.aborted).toBe(true)
  agent.teardownPersistentQuery()
})
