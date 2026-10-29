import { describe, expect, it } from 'bun:test'
import { ClaudeReasoningBlocks, ResponseUsageCollector, claudeResponseUsage } from '../backend/response-data'
import { ClaudeEventAdapter } from '../backend/claude/event-adapter'

const stream = (event: any, parent_tool_use_id: string | null = null) => ({ parent_tool_use_id, event })

describe('provider-exposed reasoning', () => {
  it('keeps main and child block identities distinct and ignores signatures/redacted blocks', () => {
    const blocks = new ClaudeReasoningBlocks()
    blocks.stream(stream({ type: 'message_start', message: { id: 'main' } }))
    blocks.stream(stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }))
    blocks.stream(stream({ type: 'message_start', message: { id: 'child' } }, 'agent'))
    blocks.stream(stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, 'agent'))
    const main = blocks.stream(stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Exposed main' } }))
    const child = blocks.stream(stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Exposed child' } }, 'agent'))
    expect(main[0]).toMatchObject({ contentKind: 'thinking', blockId: 'thinking:root:main:0', turnId: 'main' })
    expect(child[0]).toMatchObject({ contentKind: 'thinking', blockId: 'thinking:agent:child:0', parentToolUseId: 'agent' })
    expect(blocks.stream(stream({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'private' } }))).toEqual([])
    expect(blocks.assistant({ message: { id: 'redacted', content: [{ type: 'redacted_thinking', data: 'private' }] } })).toEqual([])
  })

  it('deduplicates final SDK delivery and late/replayed deltas without dropping the authoritative text', () => {
    const blocks = new ClaudeReasoningBlocks()
    const full = { message: { id: 'm', content: [{ type: 'thinking', thinking: 'Final exposed text' }] } }
    expect(blocks.assistant(full)).toHaveLength(1)
    blocks.stream(stream({ type: 'message_start', message: { id: 'm' } }))
    expect(blocks.stream(stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }))).toEqual([])
    expect(blocks.stream(stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'duplicate' } }))).toEqual([])
    expect(blocks.assistant(full)).toEqual([])
  })

  it('emits separate reasoning and prose and never adds signatures to either', async () => {
    const adapter = new ClaudeEventAdapter({ mapSDKError: async () => ({ type: 'typed_error', error: {} as any }) })
    adapter.startTurn()
    await adapter.adapt({ type: 'stream_event', ...stream({ type: 'message_start', message: { id: 'm' } }) } as any)
    await adapter.adapt({ type: 'stream_event', ...stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) } as any)
    const reasoning = await adapter.adapt({ type: 'stream_event', ...stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Provider summary' } }) } as any)
    const prose = await adapter.adapt({ type: 'stream_event', ...stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } }) } as any)
    expect(reasoning).toEqual([expect.objectContaining({ contentKind: 'thinking', text: 'Provider summary' })])
    expect(prose).toEqual([expect.objectContaining({ type: 'text_delta', text: 'Answer' })])
    expect(prose[0]).not.toHaveProperty('contentKind')
  })
})

describe('response usage is measured per message, not copied from running totals', () => {
  it('replaces repeated SDK snapshots and resets at the next response', () => {
    const collector = new ResponseUsageCollector()
    collector.record('m1', claudeResponseUsage({ model: 'served-model', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, speed: 'fast' } }))
    collector.record('m1', claudeResponseUsage({ model: 'served-model', usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 3, speed: 'fast' } }))
    collector.record('m2', claudeResponseUsage({ model: 'served-model', usage: { input_tokens: 20, output_tokens: 4, cache_creation_input_tokens: 2, speed: 'fast' } }))
    expect(collector.snapshot()).toEqual({ model: 'served-model', inputTokens: 30, outputTokens: 11, cacheReadTokens: 3, cacheCreationTokens: 2, fast: true })
    collector.clear()
    expect(collector.snapshot()).toBeUndefined()
  })

  it('omits absent/invalid values and never guesses fast from a service tier', () => {
    expect(claudeResponseUsage({ usage: { input_tokens: -1, output_tokens: NaN, service_tier: 'priority' } })).toEqual({})
    const collector = new ResponseUsageCollector()
    collector.record('a', { model: 'a', outputTokens: 2, fast: true })
    collector.record('b', { model: 'b', outputTokens: 3 })
    expect(collector.snapshot()).toEqual({ models: ['a', 'b'], outputTokens: 5 })
  })
})

it('attaches message-scoped usage instead of SDK running model totals', async () => {
  const adapter = new ClaudeEventAdapter({ mapSDKError: async () => ({ type: 'typed_error', error: {} as any }) })
  adapter.startTurn()
  const assistant = (id: string, text: string, stop_reason: string, output: number) => ({
    type: 'assistant', parent_tool_use_id: null,
    message: { id, model: 'actually-served', stop_reason, content: [{ type: 'text', text }], usage: { input_tokens: 5, output_tokens: output } },
  })
  await adapter.adapt(assistant('one', 'Checking.', 'tool_use', 3) as any)
  await adapter.adapt({ type: 'stream_event', ...stream({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }) } as any)
  await adapter.adapt(assistant('two', 'Done.', 'end_turn', 4) as any)
  const events = await adapter.adapt({ type: 'stream_event', ...stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) } as any)
  expect(events.find(event => event.type === 'text_complete')).toMatchObject({ responseUsage: { model: 'actually-served', inputTokens: 10, outputTokens: 7 } })
  const result = await adapter.adapt({ type: 'result', subtype: 'success', usage: { input_tokens: 9, output_tokens: 9999 }, modelUsage: { model: { outputTokens: 99999 } }, total_cost_usd: 100 } as any)
  expect(result.find(event => event.type === 'complete')).toMatchObject({ usage: { runningTotals: { outputTokens: 99999, costUsd: 100 } } })
  adapter.startTurn()
  await adapter.adapt(assistant('three', 'Next response.', 'end_turn', 2) as any)
  const next = adapter.flushPending()
  expect(next).toMatchObject({ responseUsage: { outputTokens: 2, inputTokens: 5 } })
})

it('keeps parent and child pending prose separate while the thinking streams interleave', async () => {
  const adapter = new ClaudeEventAdapter({ mapSDKError: async () => ({ type: 'typed_error', error: {} as any }) })
  adapter.startTurn()
  await adapter.adapt({ type: 'assistant', parent_tool_use_id: null, message: { id: 'parent-m', content: [{ type: 'text', text: 'Parent commentary' }], stop_reason: 'tool_use' } } as any)
  await adapter.adapt({ type: 'assistant', parent_tool_use_id: 'agent', message: { id: 'child-m', content: [{ type: 'text', text: 'Child result' }], stop_reason: 'end_turn' } } as any)
  const parent = await adapter.adapt({ type: 'stream_event', ...stream({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }) } as any)
  const child = await adapter.adapt({ type: 'stream_event', ...stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, 'agent') } as any)
  expect(parent.find(event => event.type === 'text_complete')).toMatchObject({ text: 'Parent commentary', turnId: 'parent-m', parentToolUseId: undefined })
  expect(child.find(event => event.type === 'text_complete')).toMatchObject({ text: 'Child result', turnId: 'child-m', parentToolUseId: 'agent' })
})

it('preserves Pi exposed thinking with the same block identity through its final message', async () => {
  const { PiEventAdapter } = await import('../backend/pi/event-adapter')
  const adapter = new PiEventAdapter()
  adapter.startTurn()
  const reasoning = [...adapter.adaptEvent({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Exposed summary', partial: {} } } as any)]
  const prose = [...adapter.adaptEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Answer', partial: {} } } as any)]
  const final = [...adapter.adaptEvent({ type: 'message_end', sdkMessageId: 'pi-id', message: { role: 'assistant', model: 'served-pi-model', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'Exposed summary' }, { type: 'text', text: 'Answer' }], usage: { input: 5, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 11, cost: { total: 0 } } } } as any)]
  const thinkingId = (reasoning[0] as any).blockId
  expect(prose[0]).not.toHaveProperty('contentKind')
  expect(final.find(event => event.type === 'text_complete' && event.contentKind === 'thinking')).toMatchObject({ blockId: thinkingId, text: 'Exposed summary' })
  expect(final.find(event => event.type === 'text_complete' && !event.contentKind)).toMatchObject({ responseUsage: { model: 'served-pi-model', inputTokens: 5, outputTokens: 3, cacheReadTokens: 2, cacheCreationTokens: 1 } })
  const replay = [...adapter.adaptEvent({ type: 'message_end', sdkMessageId: 'pi-id', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'Exposed summary' }, { type: 'text', text: 'Answer' }] } } as any)]
  expect(replay.find(event => event.type === 'text_complete' && event.contentKind === 'thinking')).toMatchObject({ blockId: thinkingId })
})


it('emits each non-streamed SDK text/tool block in source order, then finalizes the same text IDs', async () => {
  const adapter = new ClaudeEventAdapter({ mapSDKError: async () => ({ type: 'typed_error', error: {} as any }) })
  adapter.startTurn()
  const events = await adapter.adapt({ type: 'assistant', parent_tool_use_id: null, message: { id: 'mixed', stop_reason: 'end_turn', content: [
    { type: 'text', text: 'Before' }, { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'x' } }, { type: 'text', text: 'After' },
  ] } } as any)
  expect(events.filter(event => event.type === 'text_complete' || event.type === 'tool_start').map(event => event.type === 'text_complete' ? event.text : event.toolUseId)).toEqual(['Before', 'read', 'After'])
  const finals = await adapter.adapt({ type: 'stream_event', ...stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) } as any)
  expect(finals).toEqual([
    expect.objectContaining({ text: 'Before', blockId: 'text:root:mixed:0', isIntermediate: true }),
    expect.objectContaining({ text: 'After', blockId: 'text:root:mixed:2', isIntermediate: false }),
  ])
  expect(adapter.flushPending()).toBeNull()
})

it('keeps indexed streamed prose and its full SDK delivery on the same identity', async () => {
  const adapter = new ClaudeEventAdapter({ mapSDKError: async () => ({ type: 'typed_error', error: {} as any }) })
  adapter.startTurn()
  await adapter.adapt({ type: 'stream_event', ...stream({ type: 'message_start', message: { id: 'm' } }) } as any)
  const deltas = await adapter.adapt({ type: 'stream_event', ...stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Before' } }) } as any)
  const full = await adapter.adapt({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Before' }, { type: 'tool_use', id: 'read', name: 'Read', input: {} }] } } as any)
  expect(deltas[0]).toMatchObject({ blockId: 'text:root:m:0' })
  expect(full[0]).toMatchObject({ blockId: 'text:root:m:0' })
  expect(adapter.flushPending()).toMatchObject({ blockId: 'text:root:m:0', isIntermediate: true })
})


it('counts Pi full messages without IDs and includes preceding tool-only usage in this response', async () => {
  const { PiEventAdapter } = await import('../backend/pi/event-adapter')
  const usage = { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17, cost: { total: 0 } }
  const standalone = new PiEventAdapter()
  standalone.startTurn()
  const full = [...standalone.adaptEvent({ type: 'message_end', message: { role: 'assistant', model: 'served', stopReason: 'stop', usage, content: [{ type: 'text', text: 'Answer' }] } } as any)]
  expect(full.find(event => event.type === 'text_complete')).toMatchObject({ responseUsage: { inputTokens: 10, outputTokens: 4 } })
  const adapter = new PiEventAdapter()
  adapter.startTurn()
  ;[...adapter.adaptEvent({ type: 'message_end', message: { role: 'assistant', model: 'served', stopReason: 'toolUse', usage, content: [{ type: 'toolCall', id: 't', name: 'Read', arguments: {} }] } } as any)]
  ;[...adapter.adaptEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Answer', contentIndex: 0 } } as any)]
  const final = [...adapter.adaptEvent({ type: 'message_end', message: { role: 'assistant', model: 'served', stopReason: 'stop', usage, content: [{ type: 'text', text: 'Answer' }] } } as any)]
  expect(final.find(event => event.type === 'text_complete')).toMatchObject({ responseUsage: { inputTokens: 20, outputTokens: 8, cacheReadTokens: 4, cacheCreationTokens: 2 } })
})

it('streams nonempty initial Claude text before tools and shares its full-message identity', async () => {
  const adapter = new ClaudeEventAdapter({ mapSDKError: async () => ({ type: 'typed_error', error: {} as any }) })
  adapter.startTurn()
  const accept = (event: any) => adapter.adapt({ type: 'stream_event', ...stream(event) } as any)
  await accept({ type: 'message_start', message: { id: 'prefix' } })
  const prefix = await accept({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Before' } })
  expect(prefix).toEqual([expect.objectContaining({ type: 'text_delta', text: 'Before', blockId: 'text:root:prefix:0' })])
  expect(await accept({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Before' } })).toEqual([])
  const full = await adapter.adapt({ type: 'assistant', parent_tool_use_id: null, message: { id: 'prefix', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Before' }, { type: 'tool_use', id: 't', name: 'Read', input: {} }] } } as any)
  expect(full.find(event => event.type === 'text_complete')).toMatchObject({ text: 'Before', blockId: 'text:root:prefix:0' })
})
