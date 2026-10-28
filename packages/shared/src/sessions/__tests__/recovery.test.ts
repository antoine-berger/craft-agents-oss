import { describe, expect, it } from 'bun:test'
import { canResumeFailedSession, recoverAfterServerRestart } from '../recovery'

describe('failed session eligibility', () => {
  const failed = { recovery: { status: 'failed' as const, at: 1 } }
  it('includes provider quota, authentication and runtime failures', () => {
    for (const message of ['Usage limit reached', 'Authentication failed', 'Process exited unexpectedly']) {
      expect(canResumeFailedSession({ recovery: { ...failed.recovery, message } })).toBe(true)
    }
  })
  it('excludes archived, busy, hidden and nested sessions', () => {
    for (const excluded of [{isArchived:true}, {isProcessing:true}, {hidden:true}, {parentSessionId:'parent'}]) {
      expect(canResumeFailedSession({...failed,...excluded})).toBe(false)
    }
    expect(canResumeFailedSession({recovery:null})).toBe(false)
    expect(canResumeFailedSession({recovery:{status:'running',at:1}})).toBe(false)
  })
  it('detects unfinished turns after a server restart without launching them', () => {
    expect(recoverAfterServerRestart({status:'running',at:123})).toMatchObject({status:'failed',at:123})
    expect(recoverAfterServerRestart(undefined,'error')?.status).toBe('failed')
  })
  it('does not infer crashes from silence, completed replies or explicit stops', () => {
    for (const role of ['user','tool','assistant',undefined]) expect(recoverAfterServerRestart(undefined,role)).toBeUndefined()
    expect(recoverAfterServerRestart(null,'error')).toBeNull()
  })
})
