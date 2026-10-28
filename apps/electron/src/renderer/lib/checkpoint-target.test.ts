import { describe, expect, it } from 'bun:test'
import { getNextUserMessageId } from './checkpoint-target'

describe('restore after a reply', () => {
  const messages = [
    { id: 'first-question', role: 'user' as const },
    { id: 'chosen-reply', role: 'assistant' as const },
    { id: 'internal-prompt', role: 'user' as const, hidden: true },
    { id: 'internal-reply', role: 'assistant' as const },
    { id: 'next-question', role: 'user' as const },
    { id: 'last-reply', role: 'assistant' as const },
  ]

  it('uses the following prompt, never the prompt that produced the selected reply', () => {
    expect(getNextUserMessageId(messages, 'internal-reply')).toBe('next-question')
  })
  it('does not skip hidden prompts and keep later agent work by mistake', () => {
    expect(getNextUserMessageId(messages, 'chosen-reply')).toBe('internal-prompt')
  })
  it('does not choose an arbitrary checkpoint for a missing reply or the latest reply', () => {
    expect(getNextUserMessageId(messages, 'missing')).toBeUndefined()
    expect(getNextUserMessageId(messages, 'last-reply')).toBeUndefined()
  })
})
