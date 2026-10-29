import type { AgentEvent, Message } from '@craft-agent/core/types'

type ReasoningEvent = Extract<AgentEvent, { type: 'text_delta' | 'text_complete' }>

/** Upsert the same provider-exposed block in live state and persisted history. */
export function applyReasoningMessage(messages: Message[], event: ReasoningEvent, timestamp: () => number): Message | undefined {
  if (event.contentKind !== 'thinking' || !event.blockId) return undefined
  let message = messages.find(candidate => candidate.id === event.blockId && candidate.contentKind === 'thinking')
  if (!message) {
    message = {
      id: event.blockId, role: 'assistant', content: '', contentKind: 'thinking',
      timestamp: timestamp(), turnId: event.turnId, parentToolUseId: event.parentToolUseId,
      isIntermediate: true,
    }
    messages.push(message)
  }
  message.content = event.type === 'text_delta' ? message.content + event.text : event.text
  message.isStreaming = event.type === 'text_delta'
  return message
}
