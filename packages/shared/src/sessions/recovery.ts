import type { SessionRecovery } from './types'

/** Processing, archived and hidden sessions must never be batch-resumed. */
export function canResumeFailedSession(session: {
  recovery?: SessionRecovery | null
  isProcessing?: boolean
  backgroundAgentCount?: number
  isArchived?: boolean
  hidden?: boolean
  parentSessionId?: string
}): boolean {
  return session.recovery?.status === 'failed' && !session.isProcessing && !session.backgroundAgentCount
    && !session.isArchived && !session.hidden
}

export function recoverAfterServerRestart(
  recovery: SessionRecovery | null | undefined,
  lastMessageRole?: string,
): SessionRecovery | null | undefined {
  if (recovery?.status === 'running') {
    return { ...recovery, status: 'failed', reason: 'server_restart', message: 'The server stopped before this request finished.' }
  }
  // Pre-feature sessions: an explicit final error is evidence; silence alone is not.
  if (recovery === undefined && lastMessageRole === 'error') {
    return { status: 'failed', at: Date.now(), message: 'The previous request ended with an error.' }
  }
  return recovery
}

export function sessionRecoveryReason(recovery: SessionRecovery): 'server_restart' | 'quota' | 'authentication' | 'timeout' | 'connection' | 'runtime' {
  if (recovery.reason === 'server_restart') return 'server_restart'
  const message = recovery.message ?? ''
  if (/usage.?limit|rate.?limit|quota|limit reached|429/i.test(message)) return 'quota'
  if (/auth|credential|sign.?in|401|403/i.test(message)) return 'authentication'
  if (/timed?\s*out|timeout/i.test(message)) return 'timeout'
  if (/connect|network|socket|ECONN|fetch failed/i.test(message)) return 'connection'
  return 'runtime'
}
