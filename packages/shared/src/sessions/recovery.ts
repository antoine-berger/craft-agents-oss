import type { SessionRecovery } from './types'

/** Processing, archived and hidden sessions must never be batch-resumed. */
export function canResumeFailedSession(session: {
  recovery?: SessionRecovery | null
  isProcessing?: boolean
  isArchived?: boolean
  hidden?: boolean
  parentSessionId?: string
}): boolean {
  return session.recovery?.status === 'failed' && !session.isProcessing
    && !session.isArchived && !session.hidden && !session.parentSessionId
}

export function recoverAfterServerRestart(
  recovery: SessionRecovery | null | undefined,
  lastMessageRole?: string,
): SessionRecovery | null | undefined {
  if (recovery?.status === 'running') {
    return { ...recovery, status: 'failed', message: 'The server stopped before this request finished.' }
  }
  // Pre-feature sessions: an explicit final error is evidence; silence alone is not.
  if (recovery === undefined && lastMessageRole === 'error') {
    return { status: 'failed', at: Date.now(), message: 'The previous request ended with an error.' }
  }
  return recovery
}
