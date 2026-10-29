import { describe, expect, it } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager'
import { messageToStored, storedToMessage, type AgentEvent } from '@craft-agent/core/types'
import { ClaudeEventAdapter } from '@craft-agent/shared/agent/backend/claude/event-adapter'

function harness() {
  const managed = createManagedSession({ id: 'chronology' }, {
    id: 'fixture', slug: 'fixture', name: 'Fixture', rootPath: '/unused-chronology-test', createdAt: 1,
  }, { messagesLoaded: true })
  const manager = Object.create(SessionManager.prototype) as any
  let clock = 10
  manager.monotonic = () => ++clock
  manager.scheduleIdleRuntimeRelease = () => {}
  manager.notifySessionActivity = () => {}
  manager.sendEvent = () => {}
  manager.queueDelta = () => {}
  manager.flushDelta = () => {}
  manager.persistSession = () => {}
  manager.noteSuggestionUse = () => {}
  manager.getBrowserPaneManagerForSession = () => undefined
  managed.messages.push({ id: 'u', role: 'user', content: 'Do it', timestamp: 1 })
  return { managed, accept: (event: AgentEvent) => manager.processEvent(managed, event) as Promise<void> }
}
function reloadedMessages(messages: Parameters<typeof messageToStored>[0][]) {
  const persisted = messages.map(message => storedToMessage(JSON.parse(JSON.stringify(messageToStored(message)))))
  return persisted.sort((a, b) => (a.startedAt ?? a.timestamp) - (b.startedAt ?? b.timestamp))
}

describe('response chronology through the host and persistence', () => {
  it('keeps first-delta order across tools without changing final timestamp or elapsed time', async () => {
    const { managed, accept } = harness()
    await accept({ type: 'text_delta', turnId: 'm', blockId: 'text:root:m:0', text: 'Before tool' })
    await accept({ type: 'tool_start', turnId: 'm', toolUseId: 't', toolName: 'Read', input: {} })
    await accept({ type: 'text_complete', turnId: 'm', blockId: 'text:root:m:0', text: 'Before tool', isIntermediate: true })
    await accept({ type: 'text_complete', turnId: 'answer', blockId: 'text:root:answer:0', text: 'Done', isIntermediate: false })
    const prose = managed.messages.find(message => message.id === 'text:root:m:0')!
    const tool = managed.messages.find(message => message.toolUseId === 't')!
    const answer = managed.messages.at(-1)!
    expect(prose.startedAt).toBeLessThan(tool.timestamp)
    expect(prose.timestamp).toBeGreaterThan(tool.timestamp)
    const reloaded = reloadedMessages(managed.messages)
    expect(reloaded.map(message => message.content)).toEqual(['Do it', 'Before tool', 'Running Read...', 'Done'])
    expect(reloaded.at(-1)?.timestamp).toBe(answer.timestamp)
    expect(managed.lastFinalMessageId).toBe(answer.id)
  })

  it('keeps mixed full SDK blocks ordered and upserts their finalization without streaming deltas', async () => {
    const { managed, accept } = harness()
    const adapter = new ClaudeEventAdapter({ mapSDKError: async () => ({ type: 'typed_error', error: {} as any }) })
    adapter.startTurn()
    const events = await adapter.adapt({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm', stop_reason: 'end_turn', content: [
      { type: 'text', text: 'Before' }, { type: 'tool_use', id: 't', name: 'Read', input: {} }, { type: 'text', text: 'After' },
    ] } } as any)
    for (const event of events) await accept(event)
    let pending: AgentEvent | null
    while ((pending = adapter.flushPending())) await accept(pending)
    expect(managed.messages).toHaveLength(4)
    const reloaded = reloadedMessages(managed.messages)
    expect(reloaded.map(message => message.content)).toEqual(['Do it', 'Before', 'Running Read...', 'After'])
    expect(reloaded.at(-1)?.isIntermediate).toBe(false)
    expect(reloaded.at(-1)?.timestamp).toBe(managed.messages.at(-1)?.timestamp)
  })

  it('keeps a nonempty text-block prefix ahead of its following tool after full delivery and reload', async () => {
    const { managed, accept } = harness()
    const adapter = new ClaudeEventAdapter({ mapSDKError: async () => ({ type: 'typed_error', error: {} as any }) })
    adapter.startTurn()
    const stream = async (event: any) => {
      for (const adapted of await adapter.adapt({ type: 'stream_event', parent_tool_use_id: null, event } as any)) await accept(adapted)
    }
    await stream({ type: 'message_start', message: { id: 'prefix' } })
    await stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Before' } })
    await stream({ type: 'content_block_stop', index: 0 })
    await stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't', name: 'Read', input: {} } })
    for (const event of await adapter.adapt({ type: 'assistant', parent_tool_use_id: null, message: { id: 'prefix', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Before' }, { type: 'tool_use', id: 't', name: 'Read', input: {} }] } } as any)) await accept(event)
    expect(reloadedMessages(managed.messages).map(message => message.content)).toEqual(['Do it', 'Before', 'Running Read...'])
  })

})
