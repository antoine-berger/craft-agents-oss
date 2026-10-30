import type { SessionAttention } from '@craft-agent/shared/protocol'
import type { SessionMeta } from '@/atoms/sessions'

export type SessionRunState = 'plan' | 'permission' | 'question' | 'failed' | 'working' | 'waiting' | null

/** Pending input wins over activity. The owner's yellow-hand preference also covers GitHub attention. */
export function sessionRunState(item: SessionMeta, attention: SessionAttention | undefined, pendingPermission: boolean, working: boolean, waiting: boolean): SessionRunState {
  const reasons = attention?.status === 'needs-human' ? attention.reasons : []
  if (reasons.some(reason => reason.kind === 'plan') || (!working && item.lastMessageRole === 'plan')) return 'plan'
  if (pendingPermission || reasons.some(reason => reason.kind === 'permission' || reason.kind === 'authentication')) return 'permission'
  if (reasons.some(reason => reason.kind === 'question')) return 'question'
  if (reasons.some(reason => reason.kind === 'review' || reason.kind === 'ci' || reason.kind === 'ship')) return 'question'
  if (working) return waiting ? 'waiting' : 'working'
  // Craft exposes failed requests rather than Conductor's failed-workspace field.
  if (reasons.some(reason => reason.kind === 'error') || item.recovery?.status === 'failed' || item.lastMessageRole === 'error') return 'failed'
  return null
}
