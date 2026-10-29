import { describe, expect, it } from 'bun:test'
import { handleTextDelta, handleTextComplete } from '../text'
import type { SessionState } from '../../types'

const initial = (): SessionState => ({ session: { id: 's', messages: [], lastMessageAt: 1 } as any, streaming: null })

describe('reasoning alongside prose', () => {
  it('never appends reasoning to the prose buffer and never finalizes it as an answer', () => {
    let state = initial()
    state = handleTextDelta(state, { type: 'text_delta', sessionId: 's', turnId: 'm', contentKind: 'thinking', blockId: 'thinking:m:0', delta: 'Exposed summary', timestamp: 10 })
    expect(state.streaming).toBeNull()
    state = handleTextDelta(state, { type: 'text_delta', sessionId: 's', turnId: 'm', delta: 'Answer' })
    expect(state.session.messages).toHaveLength(2)
    expect(state.streaming?.content).toBe('Answer')
    state = handleTextComplete(state, { type: 'text_complete', sessionId: 's', turnId: 'm', contentKind: 'thinking', blockId: 'thinking:m:0', messageId: 'thinking:m:0', text: 'Exposed summary complete', timestamp: 10 })
    expect(state.streaming?.content).toBe('Answer')
    state = handleTextComplete(state, { type: 'text_complete', sessionId: 's', turnId: 'm', messageId: 'answer', text: 'Answer complete', responseUsage: { outputTokens: 7 } })
    expect(state.session.messages).toHaveLength(2)
    expect(state.session.messages[0]).toMatchObject({ contentKind: 'thinking', content: 'Exposed summary complete', isIntermediate: true })
    expect(state.session.messages[1]).toMatchObject({ id: 'answer', content: 'Answer complete', responseUsage: { outputTokens: 7 } })
    expect(state.session.messages[1]).not.toHaveProperty('contentKind')
  })
})

it('does not join interleaved parent and child prose into the same streaming message', () => {
  let state = initial()
  state = handleTextDelta(state, { type: 'text_delta', sessionId: 's', turnId: 'parent', delta: 'Parent ' })
  state = handleTextDelta(state, { type: 'text_delta', sessionId: 's', turnId: 'child', parentToolUseId: 'agent', delta: 'Child ' })
  state = handleTextDelta(state, { type: 'text_delta', sessionId: 's', turnId: 'parent', delta: 'answer' })
  expect(state.session.messages.map(message => message.content)).toEqual(['Parent answer', 'Child '])
  expect(state.session.messages[1]?.parentToolUseId).toBe('agent')
  state = handleTextComplete(state, { type: 'text_complete', sessionId: 's', turnId: 'child', text: '', messageId: 'child-final', parentToolUseId: 'agent' })
  expect(state.session.messages[1]?.content).toBe('Child ')
  expect(state.streaming?.content).toBe('Parent answer')
})


it('upserts provisional SDK blocks and final stop reasons without reordering text around tools', () => {
  let state = initial()
  const block = 'text:root:m:0'
  state = handleTextDelta(state, { type: 'text_delta', sessionId: 's', turnId: 'm', blockId: block, delta: 'Before the tool', timestamp: 10 })
  state.session.messages.push({ id: 'tool', role: 'tool', content: '', timestamp: 20, toolUseId: 't', toolName: 'Read' })
  state = handleTextComplete(state, { type: 'text_complete', sessionId: 's', turnId: 'm', blockId: block, messageId: block, text: 'Before the tool', timestamp: 30, startedAt: 10, isIntermediate: true })
  state = handleTextComplete(state, { type: 'text_complete', sessionId: 's', turnId: 'm', blockId: block, messageId: block, text: 'Before the tool', timestamp: 35, startedAt: 10, isIntermediate: true })
  expect(state.session.messages).toHaveLength(2)
  expect(state.session.messages[0]).toMatchObject({ id: block, startedAt: 10, timestamp: 35, content: 'Before the tool' })
  expect(state.session.lastMessageAt).toBe(1)
  const completed = state
  state = handleTextDelta(state, { type: 'text_delta', sessionId: 's', turnId: 'm', blockId: block, delta: 'Late duplicate' })
  expect(state).toBe(completed)
  state = handleTextComplete(state, { type: 'text_complete', sessionId: 's', turnId: 'm', blockId: 'text:root:m:2', text: 'Done', timestamp: 50, startedAt: 40 })
  expect(state.session.messages).toHaveLength(3)
  expect(state.session.lastMessageAt).toBeGreaterThan(1)
})
