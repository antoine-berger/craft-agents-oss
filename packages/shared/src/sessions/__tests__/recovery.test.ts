import { describe, expect, it } from 'bun:test'
import { canResumeFailedSession, recoverAfterServerRestart, sessionRecoveryReason } from '../recovery'

describe('failed session eligibility', () => {
  const failed = { recovery: { status: 'failed' as const, at: 1 } }
  it('includes provider quota, authentication and runtime failures', () => {
    for (const message of ['Usage limit reached', 'Authentication failed', 'Process exited unexpectedly']) {
      expect(canResumeFailedSession({ recovery: { ...failed.recovery, message } })).toBe(true)
    }
  })
  it('includes visible child chats but excludes archived, busy and hidden sessions', () => {
    expect(canResumeFailedSession({...failed,parentSessionId:'parent'})).toBe(true)
    for (const excluded of [{isArchived:true}, {isProcessing:true}, {backgroundAgentCount:1}, {hidden:true}]) {
      expect(canResumeFailedSession({...failed,...excluded})).toBe(false)
    }
    expect(canResumeFailedSession({recovery:null})).toBe(false)
    expect(canResumeFailedSession({recovery:{status:'running',at:1}})).toBe(false)
  })
  it('detects unfinished turns after a server restart without launching them', () => {
    expect(recoverAfterServerRestart({status:'running',at:123})).toMatchObject({status:'failed',at:123,reason:'server_restart'})
    expect(recoverAfterServerRestart(undefined,'error')?.status).toBe('failed')
  })
  it('groups actionable reasons without putting raw provider errors in the toolbar', () => {
    for (const [message, reason] of [['Usage limit reached', 'quota'], ['429 Too Many Requests', 'quota'],
      ['Authentication failed', 'authentication'], ['The agent timed out.', 'timeout'], ['ECONNRESET', 'connection'],
      ['Process exited with code 143', 'runtime']] as const) {
      expect(sessionRecoveryReason({ ...failed.recovery, message })).toBe(reason)
    }
    expect(sessionRecoveryReason(recoverAfterServerRestart({status:'running',at:123})!)).toBe('server_restart')
  })
  it('does not infer crashes from silence, completed replies or explicit stops', () => {
    for (const role of ['user','tool','assistant',undefined]) expect(recoverAfterServerRestart(undefined,role)).toBeUndefined()
    expect(recoverAfterServerRestart(null,'error')).toBeNull()
  })
})
