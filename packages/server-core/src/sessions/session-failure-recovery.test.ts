import { beforeEach, describe, expect, it } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager'
import { canResumeFailedSession, recoverAfterServerRestart } from '@craft-agent/shared/sessions'

describe('interrupted session recovery', () => {
  let sm: any, chat: any, writes: any[]
  beforeEach(() => {
    sm = new SessionManager()
    chat = createManagedSession({ id: 'chat' }, { id: 'workspace', rootPath: '/tmp/recovery-test' } as any, { messagesLoaded: true })
    sm.sessions.set(chat.id, chat)
    writes = []
    sm.persistSession = () => writes.push(structuredClone(chat.recovery))
    sm.sendEvent = () => {}
    sm.sendMessage = async () => {}
    sm.getBrowserPaneManagerForSession = () => null
  })
  const task = () => ({ taskId: 'task', kind: 'agent', status: 'running', startTime: 1 })

  it('preserves unfinished work before shutdown cleanup and trailing completion', async () => {
    sm.setProcessing(chat, true)
    sm.prepareForShutdown()
    await sm.onProcessingStopped(chat.id, 'complete')
    expect(chat.recovery).toMatchObject({ status: 'failed', reason: 'server_restart' })
    expect(writes.at(-1)).toEqual(chat.recovery)
    expect(canResumeFailedSession({ ...chat, isProcessing: false })).toBe(true)
  })

  it('keeps idle background work recoverable on a hard crash', async () => {
    sm.setProcessing(chat, true)
    chat.backgroundTaskRegistry.set('task', task())
    await sm.onProcessingStopped(chat.id, 'complete')
    expect(chat.isProcessing).toBe(false)
    expect(chat.recovery?.status).toBe('running')
    expect(recoverAfterServerRestart(chat.recovery)).toMatchObject({ status: 'failed', reason: 'server_restart' })
  })

  it('does not erase a runtime failure when the SDK ends with an abort', async () => {
    sm.setProcessing(chat, true)
    sm.recordSessionFailure(chat, 'Process exited unexpectedly')
    await sm.onProcessingStopped(chat.id, 'interrupted')
    expect(chat.recovery).toMatchObject({ status: 'failed', message: 'Process exited unexpectedly' })
  })

  it('reports a background task killed without an owner stop', async () => {
    chat.recovery = { status: 'running', at: 1 }
    chat.backgroundTaskRegistry.set('task', task())
    await sm.processEvent(chat, { type: 'task_completed', taskId: 'task', status: 'stopped' })
    expect(chat.recovery?.status).toBe('failed')
    expect(canResumeFailedSession(chat)).toBe(true)
  })

  it('does not retry completed chats, archives, or an explicit owner stop', async () => {
    sm.prepareForShutdown()
    expect(chat.recovery).toBeUndefined()
    sm = new SessionManager()
    sm.sessions.set(chat.id, chat)
    sm.persistSession = () => {}
    sm.sendEvent = () => {}
    sm.getBrowserPaneManagerForSession = () => null
    sm.setProcessing(chat, true)
    chat.stopRequested = true
    chat.recovery = null
    await sm.onProcessingStopped(chat.id, 'interrupted')
    chat.backgroundTaskRegistry.set('task', task())
    sm.prepareForShutdown()
    expect(chat.recovery).toBeNull()
    chat.isArchived = true
    chat.isProcessing = true
    expect(canResumeFailedSession(chat)).toBe(false)
  })

  it('claims a retry once, in the same chat', async () => {
    chat.recovery = { status: 'failed', at: 1 }
    let sends = 0
    sm.disposeManagedAgentRuntime = async () => true
    sm.sendMessage = async (id: string, text: string) => { expect(id).toBe(chat.id); expect(text).toBe('Continue.'); sends++ }
    sm.resumeFailedSession(chat.id)
    sm.resumeFailedSession(chat.id)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sends).toBe(1)
  })

  it('restores queued prompts once instead of adding Continue on top', async () => {
    chat.recovery = { status: 'failed', at: 1 }
    chat.messages = [{ id: 'prompt', role: 'user', content: '/ship', isQueued: true, timestamp: 1 }]
    sm.disposeManagedAgentRuntime = async () => true
    let dequeues = 0
    sm.processNextQueuedMessage = () => { dequeues++ }
    sm.sendMessage = async () => { throw new Error('Must use the existing queue') }
    sm.resumeFailedSession(chat.id)
    sm.resumeFailedSession(chat.id)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(chat.messageQueue.map((item: any) => item.messageId)).toEqual(['prompt'])
    expect(dequeues).toBe(1)
  })

  it('resumes in the existing agent without disposing surviving background commands', async () => {
    chat.recovery = { status: 'failed', at: 1 }
    chat.backgroundTaskRegistry.set('task', task())
    chat.agent = {}
    let sends = 0
    sm.disposeManagedAgentRuntime = async () => { throw new Error('Must preserve background commands') }
    sm.sendMessage = async (id: string, text: string) => { expect(id).toBe(chat.id); expect(text).toBe('Continue.'); sends++ }
    sm.resumeFailedSession(chat.id)
    sm.resumeFailedSession(chat.id)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sends).toBe(1)
    expect(chat.backgroundTaskRegistry.get('task').status).toBe('running')
  })

  it('does not replace an unavailable runtime while background work is still registered', () => {
    chat.recovery = { status: 'failed', at: 1 }
    chat.backgroundTaskRegistry.set('task', task())
    expect(() => sm.resumeFailedSession(chat.id)).toThrow('agent is unavailable')
    expect(chat.recovery?.status).toBe('failed')
  })

  it('makes the chat resumable when its idle process exits after a sibling task failed', () => {
    chat.recovery = { status: 'failed', at: 1, message: 'Task failed' }
    chat.backgroundTaskRegistry.set('task', task())
    sm.processBackgroundEvent(chat, { type: 'error', message: 'Process exited with code 137' })
    expect(chat.backgroundTaskRegistry.get('task').status).toBe('orphaned')
    expect(sm.getSessionSnapshot(chat.id).backgroundAgentCount).toBe(0)
    sm.resumeFailedSession(chat.id)
    expect(chat.recovery.status).toBe('running')
  })

  it('retires dead background tasks without re-enabling an intentionally stopped chat', () => {
    chat.recovery = null
    chat.backgroundTaskRegistry.set('task', task())
    sm.processBackgroundEvent(chat, { type: 'error', message: 'Process exited with code 137' })
    expect(chat.backgroundTaskRegistry.get('task').status).toBe('orphaned')
    expect(chat.recovery).toBeNull()
  })

  it('clears the recovery marker when all background work finishes normally', async () => {
    chat.recovery = { status: 'running', at: 1 }
    chat.backgroundTaskRegistry.set('task', { ...task(), stopRequestedAt: 2 })
    await sm.processEvent(chat, { type: 'task_completed', taskId: 'task', status: 'completed' })
    expect(chat.recovery).toBeNull()
    sm.prepareForShutdown()
    expect(chat.recovery).toBeNull()
  })
})
