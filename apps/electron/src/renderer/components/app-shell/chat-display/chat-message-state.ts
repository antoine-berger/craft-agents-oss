import type { Message } from '../../../../shared/types'

export type ChatMessageState = 'interrupted' | 'retrying' | 'limit' | 'context' | 'auth' | 'error'

/** Classify only recorded state; no reset times or retry attempts are inferred. */
export function chatMessageState(message: Message): ChatMessageState {
  if (message.statusType === 'retrying') return 'retrying'
  if (/^(?:response )?interrupted(?: by user| by the owner)?[.!]?$/i.test(message.content.trim())
    || /aborted by user/i.test(message.content)) return 'interrupted'
  if (message.errorCode === 'rate_limited' || /(?:usage|rate|session) limit (?:reached|exceeded)/i.test(message.content)) return 'limit'
  if (/context_length_exceeded|context (?:window|length).*(?:exceed|full)|(?:exceed|full).*context (?:window|length)/i.test(message.content)) return 'context'
  if (['invalid_api_key', 'invalid_credentials', 'expired_oauth_token', 'token_expired', 'mcp_auth_required'].includes(message.errorCode ?? '')) return 'auth'
  return 'error'
}

/** Claude's explicit reset marker is a provider timestamp, unlike generic rate-limit advice. */
export function recordedLimitReset(content: string): Date | undefined {
  const match = /^Claude AI usage limit reached\|\s*(\d+)\s*$/.exec(content.trim())
  if (!match) return undefined
  const milliseconds = Number(match[1]) * 1000
  return Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds < 8.64e15 ? new Date(milliseconds) : undefined
}
