import { describe, expect, it } from 'bun:test'
import type { Message } from '../../../../shared/types'
import { chatMessageState, recordedLimitReset } from './chat-message-state'
import { summarizeBackgroundTasks } from '../background-task-summary'
import type { BackgroundTask } from '@/atoms/sessions'

const message = (content: string, extra: Partial<Message> = {}): Message => ({ id: 'm', role: 'error', content, timestamp: 1, ...extra })
const task = (id: string, extra: Partial<BackgroundTask> = {}): BackgroundTask => ({ id, type: 'agent', isSubagent: true, toolUseId: id, startTime: 1000, elapsedSeconds: 2, status: 'running', ...extra })

describe('recorded chat state', () => {
  it('distinguishes an owner interruption from a failed operation', () => {
    expect(chatMessageState(message('Response interrupted.'))).toBe('interrupted')
    expect(chatMessageState(message('The network interrupted the download.'))).toBe('error')
    expect(chatMessageState(message('Retrying after failure', { statusType: 'retrying' }))).toBe('retrying')
  })
  it('distinguishes limit, context and authentication without inventing provider metadata', () => {
    expect(chatMessageState(message('Too many requests', { errorCode: 'rate_limited' }))).toBe('limit')
    expect(chatMessageState(message('Input exceeded the context window'))).toBe('context')
    expect(chatMessageState(message('Please reconnect', { errorCode: 'expired_oauth_token' }))).toBe('auth')
    expect(recordedLimitReset('Limits reset after a short period')).toBeUndefined()
    expect(recordedLimitReset('Claude AI usage limit reached|1793282400')?.getTime()).toBe(1793282400000)
    expect(recordedLimitReset('Claude AI usage limit reached|9999999999999999')).toBeUndefined()
  })
})

describe('aggregate background work', () => {
  it('groups live agents while keeping the real oldest start time', () => {
    const summary = summarizeBackgroundTasks([task('a'), task('b', { startTime: 2000 })], 61000)
    expect(summary).toEqual({ label: 'Waiting for 2 agents', running: true, pending: true, elapsed: 60 })
    expect(summarizeBackgroundTasks([task('a', { intent: 'Review parser' })], 3000)?.label).toBe('Waiting for subagent Review parser')
  })
  it('does not show running after completion or unconfirmed liveness', () => {
    const finished = task('a', { status: 'completed', completedAt: 4000, intent: 'Review parser' })
    expect(summarizeBackgroundTasks([finished], 900000)).toEqual({ label: 'Review parser', running: false, pending: false, elapsed: 3 })
    expect(summarizeBackgroundTasks([task('a', { status: 'stale', intent: 'Review parser' })], 900000)?.running).toBe(false)
    expect(summarizeBackgroundTasks([task('a', { status: 'stale', intent: 'Review parser' })], 900000)?.label).toContain('No signal')
    expect(summarizeBackgroundTasks([], 900000)).toBeNull()
  })
  it('keeps stopped and failed output available without calling it waiting work', () => {
    const summary = summarizeBackgroundTasks([task('a', { status: 'failed', summary: 'Build failed', completedAt: 4000 })], 9000)
    expect(summary?.label).toBe('Build failed')
    expect(summary?.pending).toBe(false)
  })
})
