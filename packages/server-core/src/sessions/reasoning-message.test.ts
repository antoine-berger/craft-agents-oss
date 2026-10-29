import { describe, expect, it } from 'bun:test'
import type { Message } from '@craft-agent/core/types'
import { messageToStored, storedToMessage } from '@craft-agent/core/types'
import { applyReasoningMessage } from './reasoning-message'

describe('reasoning block persistence', () => {
  it('keeps one block, preserves its first timestamp and overwrites partials with authoritative content', () => {
    const messages: Message[] = []
    const base = { turnId: 'sdk-message', blockId: 'thinking:block', contentKind: 'thinking' as const }
    applyReasoningMessage(messages, { ...base, type: 'text_delta', text: 'Partial' }, () => 10)
    applyReasoningMessage(messages, { ...base, type: 'text_delta', text: ' text' }, () => 20)
    applyReasoningMessage(messages, { ...base, type: 'text_complete', text: 'Final provider summary', isIntermediate: true }, () => 30)
    applyReasoningMessage(messages, { ...base, type: 'text_complete', text: 'Final provider summary', isIntermediate: true }, () => 40)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: 'thinking:block', timestamp: 10, content: 'Final provider summary', contentKind: 'thinking', isIntermediate: true, isStreaming: false })
    const restored = storedToMessage(JSON.parse(JSON.stringify(messageToStored(messages[0]!))))
    expect(restored).toMatchObject({ contentKind: 'thinking', content: 'Final provider summary', turnId: 'sdk-message' })
    expect(restored).not.toHaveProperty('isStreaming')
  })

  it('does not create a block when no exposed reasoning identity is supplied', () => {
    const messages: Message[] = []
    expect(applyReasoningMessage(messages, { type: 'text_delta', text: 'ordinary prose' }, () => 10)).toBeUndefined()
    expect(messages).toEqual([])
  })
})
