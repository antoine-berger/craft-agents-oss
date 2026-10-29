/**
 * Text Event Handlers
 *
 * Handles text_delta and text_complete events.
 * Pure functions that return new state - no side effects.
 */

import type { SessionState, StreamingState, TextDeltaEvent, TextCompleteEvent, TextDiscardEvent } from '../types'
import { handleReasoning } from './reasoning'
import type { Message } from '../../../shared/types'
import {
  findStreamingMessage,
  findAssistantMessage,
  updateMessageAt,
  appendMessage,
  generateMessageId
} from '../helpers'

/** Discard only the failed attempt's unfinished text, never completed history. */
export function handleTextDiscard(state: SessionState, event: TextDiscardEvent): SessionState {
  return {
    session: {
      ...state.session,
      messages: state.session.messages.filter(m => !(
        m.role === 'assistant' && m.turnId === event.turnId && (m.isStreaming || m.isPending)
      )),
    },
    streaming: state.streaming?.turnId === event.turnId ? null : state.streaming,
  }
}

/**
 * Handle text_delta - accumulate streaming content
 *
 * Creates a new streaming message if none exists, otherwise updates existing.
 * Uses turnId for lookup, never position.
 */
export function handleTextDelta(
  state: SessionState,
  event: TextDeltaEvent
): SessionState {
  if (event.contentKind === 'thinking') return handleReasoning(state, event)
  // Output may have been batched before a retry began. Only an explicit retry
  // lifecycle event can clear the backoff indicator.
  const { session, streaming } = state
  // A complete SDK block is authoritative; late/replayed deltas must not append it again.
  if (event.blockId && session.messages.some(message => message.id === event.blockId && !message.isStreaming)) return state
  const streamingIndex = findStreamingMessage(session.messages, event.turnId, event.blockId)

  // Accumulate in streaming state
  const newStreaming: StreamingState = streaming && (!event.turnId || streaming.turnId === event.turnId) && (!event.blockId || streaming.blockId === event.blockId)
    ? {
        ...streaming,
        content: streaming.content + event.delta,
        blockId: event.blockId ?? streaming.blockId,
        turnId: event.turnId ?? streaming.turnId
      }
    : {
        content: (streamingIndex !== -1 ? session.messages[streamingIndex]!.content : '') + event.delta,
        turnId: event.turnId,
        blockId: event.blockId,
      }

  // Find existing streaming message by turnId
  if (streamingIndex !== -1) {
    // Message exists - update its content
    const currentMsg = session.messages[streamingIndex]
    const updatedSession = updateMessageAt(session, streamingIndex, {
      content: currentMsg.content + event.delta,
    })
    return { session: updatedSession, streaming: newStreaming }
  }

  // No streaming message found - create new one
  // Don't update lastMessageAt for streaming messages (they're intermediate)
  const newMessage: Message = {
    id: event.blockId ?? generateMessageId(),
    role: 'assistant',
    content: event.delta,
    timestamp: event.timestamp ?? Date.now(),
    startedAt: event.timestamp,
    isStreaming: true,
    isPending: true,
    turnId: event.turnId,
    parentToolUseId: event.parentToolUseId,
  }

  return {
    session: appendMessage(session, newMessage, false),
    streaming: newStreaming,
  }
}

/**
 * Handle text_complete - finalize the streaming message
 *
 * Sets isStreaming: false, isPending: false.
 * If message not found, CREATES it (fixes race condition bug).
 * Uses complete text from SDK (event.text), not accumulated content.
 */
export function handleTextComplete(
  state: SessionState,
  event: TextCompleteEvent
): SessionState {
  if (event.contentKind === 'thinking') return handleReasoning(state, event)
  const session = state.session
  const streaming = (!event.turnId || state.streaming?.turnId === event.turnId) && (!event.blockId || state.streaming?.blockId === event.blockId) ? state.streaming : null
  const remainingStreaming = state.streaming === streaming ? null : state.streaming

  // Find message by turnId (try streaming first, then any assistant)
  let msgIndex = findStreamingMessage(session.messages, event.turnId, event.blockId)
  if (msgIndex === -1) {
    msgIndex = findAssistantMessage(session.messages, event.turnId, event.blockId)
  }

  if (msgIndex !== -1) {
    const existingMsg = session.messages[msgIndex]

    // Don't overwrite a completed intermediate message with another intermediate —
    // each thinking block (e.g. Codex reasoning between tool calls) should be distinct
    if (!event.blockId && !existingMsg.isStreaming && existingMsg.isIntermediate && event.isIntermediate) {
      msgIndex = -1
    }
  }

  if (msgIndex !== -1) {
    // Update existing message with final content
    // Only update lastMessageAt for final (non-intermediate) messages
    const shouldUpdateTimestamp = !event.isIntermediate
    const existingMsg = session.messages[msgIndex]
    // Fallback chain: SDK event text → accumulated streaming content → existing message content.
    // Guards against SDK quirks or race conditions where event.text arrives empty.
    const resolvedContent = event.text || streaming?.content || existingMsg?.content || ''
    const updatedSession = updateMessageAt(session, msgIndex, {
      // Replace temporary renderer-generated ID with authoritative main-process ID
      // so branchFromMessageId always resolves against persisted session.jsonl.
      ...(event.messageId ? { id: event.messageId } : {}),
      content: resolvedContent,
      isStreaming: false,
      isPending: false,
      isIntermediate: event.isIntermediate,
      turnId: event.turnId,
      parentToolUseId: event.parentToolUseId,
      responseUsage: event.responseUsage,
      startedAt: event.startedAt ?? existingMsg?.startedAt,
      // Overwrite text_delta's Date.now() with main process monotonic timestamp
      // This ensures reload order matches live order
      ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    }, shouldUpdateTimestamp)
    return { session: updatedSession, streaming: remainingStreaming }
  }

  // Message not found - CREATE IT
  // This handles the race condition where text_complete arrives
  // before text_delta's setSessions has been processed
  const newMessage: Message = {
    id: event.messageId ?? event.blockId ?? generateMessageId(),
    role: 'assistant',
    content: event.text || streaming?.content || '',
    timestamp: event.timestamp ?? Date.now(),
    isStreaming: false,
    isPending: false,
    isIntermediate: event.isIntermediate,
    turnId: event.turnId,
    parentToolUseId: event.parentToolUseId,
    responseUsage: event.responseUsage,
    startedAt: event.startedAt,
  }

  // Only update lastMessageAt for final (non-intermediate) messages
  const shouldUpdateTimestamp = !event.isIntermediate

  return {
    session: appendMessage(session, newMessage, shouldUpdateTimestamp),
    streaming: remainingStreaming,
  }
}
