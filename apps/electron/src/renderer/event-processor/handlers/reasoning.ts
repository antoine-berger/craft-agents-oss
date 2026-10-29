import type { Message } from '../../../shared/types'
import type { SessionState, TextDeltaEvent, TextCompleteEvent } from '../types'
import { appendMessage, updateMessageAt } from '../helpers'

/** Reasoning has its own identity and must never consume or append to prose's stream buffer. */
export function handleReasoning(state: SessionState, event: TextDeltaEvent | TextCompleteEvent): SessionState {
  const id = event.type === 'text_complete' ? event.messageId ?? event.blockId : event.blockId
  if (!id) return state
  const index = state.session.messages.findIndex(message => message.id === id && message.contentKind === 'thinking')
  const complete = event.type === 'text_complete'
  const text = complete ? event.text : (index < 0 ? '' : state.session.messages[index]!.content) + event.delta
  const changes: Partial<Message> = { content: text, isIntermediate: true, isPending: false, isStreaming: !complete }
  if (index >= 0) return { ...state, session: updateMessageAt(state.session, index, changes, false) }
  return { ...state, session: appendMessage(state.session, {
    id, role: 'assistant', contentKind: 'thinking', content: text,
    timestamp: event.timestamp ?? Date.now(),
    turnId: event.turnId, parentToolUseId: event.parentToolUseId,
    isIntermediate: true, isPending: false, isStreaming: !complete,
  }, false) }
}
