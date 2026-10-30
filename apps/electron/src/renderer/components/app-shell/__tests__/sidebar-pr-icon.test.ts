import { describe, expect, it } from 'bun:test'
import { prIconState, type PrSummary } from '../chat-header/pr-watch/pr-watch-state'
import { sessionRunState } from '../session-run-state'
import type { SessionMeta } from '@/atoms/sessions'
import type { SessionAttention, AttentionKind } from '@craft-agent/shared/protocol'
import reference from './fixtures/conductor-status-icons.json'

const item = { id: 'session' } as SessionMeta
function attention(...kinds: AttentionKind[]): SessionAttention {
  return { sessionId: 'session', status: 'needs-human', githubStale: false, updatedAt: 1,
    reasons: kinds.map((kind, index) => ({ id: String(index), source: 'agent', kind, title: kind, createdAt: 1, action: { type: 'session' } })) }
}

describe('Conductor classic PR priorities', () => {
  for (const vector of reference.cases) {
    it(vector.name, () => expect(prIconState(vector.summary as PrSummary) as string).toBe(vector.expected))
  }
  it('retains the freshness guard without claiming an old queue or ready state', () => {
    for (const vector of reference.cases.filter(value => !['merged', 'closed'].includes(value.summary.state))) {
      expect(prIconState({ ...vector.summary, attentionStale: true } as PrSummary) as string).toBe(vector.summary.state)
    }
  })
})

describe('session attention and activity', () => {
  it('retains plan, permission and question priority once activity stops', () => {
    expect(sessionRunState(item, attention('question', 'plan', 'permission'), true, false, false)).toBe('plan')
    expect(sessionRunState(item, attention('question'), true, false, false)).toBe('permission')
    expect(sessionRunState(item, attention('question'), false, false, false)).toBe('question')
  })
  it('keeps the requested yellow-hand attention for GitHub feedback', () => {
    expect(sessionRunState(item, attention('review'), false, false, false)).toBe('question')
  })
  it('shows working and subagent animations ahead of outstanding attention', () => {
    for (const kind of ['plan', 'permission', 'authentication', 'question', 'review', 'ci', 'ship', 'error'] as const) {
      expect(sessionRunState(item, attention(kind), true, true, false)).toBe('working')
      expect(sessionRunState(item, attention(kind), true, true, true)).toBe('waiting')
    }
  })
  it('restores the yellow hand after work completes and removes it when attention clears', () => {
    const pending = attention('review')
    expect(sessionRunState(item, pending, false, true, false)).toBe('working')
    expect(sessionRunState(item, pending, false, false, false)).toBe('question')
    expect(sessionRunState(item, undefined, false, false, false)).toBeNull()
  })
  it('uses actual activity and failed-request metadata, without inventing setup/cancelling', () => {
    const failed = { ...item, recovery: { status: 'failed', at: 1 } } as SessionMeta
    expect(sessionRunState(failed, undefined, false, true, false)).toBe('working')
    expect(sessionRunState(failed, undefined, false, true, true)).toBe('waiting')
    expect(sessionRunState(failed, undefined, false, false, false)).toBe('failed')
    expect(sessionRunState(item, undefined, false, false, false)).toBeNull()
  })
  it('does not mistake the real server error-attention event for a question', () => {
    expect(sessionRunState(item, attention('error'), false, false, false)).toBe('failed')
    expect(sessionRunState(item, attention('error'), false, true, false)).toBe('working')
    expect(sessionRunState(item, attention('error', 'question'), false, true, false)).toBe('working')
  })
})
