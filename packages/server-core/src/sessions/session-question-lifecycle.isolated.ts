import { describe, expect, it } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager'
import type { SessionEvent } from '@craft-agent/shared/protocol'

function harness() {
  const managed = createManagedSession({ id: 'questions' }, {
    id: 'fixture', slug: 'fixture', name: 'Fixture', rootPath: '/unused-question-test', createdAt: 1,
  }, { messagesLoaded: true })
  managed.isProcessing = true
  const manager = Object.create(SessionManager.prototype) as any
  const events: SessionEvent[] = []
  manager.sessions = new Map([[managed.id, managed]])
  manager.archiveStops = new Map()
  manager.sendEvent = (event: SessionEvent) => { events.push(event) }
  manager.scheduleIdleRuntimeRelease = () => {}
  manager.setSessionRecovery = () => {}
  manager.worktreeSetupControllers = new Map()
  manager.recoverPendingSteers = () => {}
  manager.clearPendingPermissionRequestsForSession = () => {}
  manager.clearAdminRememberApprovalsForSession = () => {}
  manager.onProcessingStopped = () => { managed.isProcessing = false }
  return { manager, managed, events }
}
const questions = [{ question: 'Which target?', options: [{ label: 'Preview' }, { label: 'Production' }] }]

describe('question host lifecycle', () => {
  it('Cancel agent delivers cancellation and invokes Stop before the awaiting tool can resume', async () => {
    const { manager, managed, events } = harness()
    const pending = manager.requestUserQuestion(managed, questions).then((response: unknown) => ({ response, stopped: managed.stopRequested }))
    const request = manager.getPendingQuestion(managed.id)
    manager.respondToQuestion(managed.id, request.requestId, { cancelled: true, answers: [], cancelAction: 'skip' })
    expect(await pending).toEqual({ response: { cancelled: true, answers: [] }, stopped: true })
    expect(manager.getPendingQuestion(managed.id)).toBeNull()
    expect(events.some(event => event.type === 'interrupted')).toBe(true)
  })
  it('Stop rejects the awaiting tool and removes the actionable form', async () => {
    const { manager, managed } = harness()
    const pending = manager.sessionQuestions.ask(managed.id, questions).catch((error: Error) => error)
    await manager.cancelProcessing(managed.id, true)
    expect((await pending).message).toContain('owner stopped')
    expect(manager.getPendingQuestion(managed.id)).toBeNull()
  })
  it('archive cleanup cancels the request and server refuses stale answers to the archived chat', async () => {
    const { manager, managed } = harness()
    const pending = manager.sessionQuestions.ask(managed.id, questions).catch((error: Error) => error)
    const request = manager.getPendingQuestion(managed.id)
    managed.isArchived = true
    manager.clearArchivedSessionWork(managed)
    expect((await pending).message).toContain('archived')
    expect(manager.getPendingQuestion(managed.id)).toBeNull()
    expect(() => manager.respondToQuestion(managed.id, request.requestId, { cancelled: true, answers: [] })).toThrow('archived')
  })
  it('a normal turn ending cannot leave an unresolved tool request', async () => {
    const { manager, managed, events } = harness()
    const pending = manager.sessionQuestions.ask(managed.id, questions).catch((error: Error) => error)
    manager.setProcessing(managed, false)
    expect((await pending).message).toContain('turn ended')
    expect(events.at(-1)).toMatchObject({ type: 'question_changed', request: null })
  })
  it('a live background agent can ask and receive answers after foreground completion, until its runtime ends', async () => {
    const { manager, managed } = harness()
    manager.keepBackgroundTasksAlive = true
    managed.backgroundTaskRegistry.set('agent', { taskId: 'agent', startTime: 1, status: 'running', kind: 'agent' })
    const first = manager.requestUserQuestion(managed, questions)
    manager.setProcessing(managed, false)
    const request = manager.getPendingQuestion(managed.id)
    expect(request).not.toBeNull()
    manager.respondToQuestion(managed.id, request.requestId, { answers: [{ selected: ['Preview'] }] })
    expect(await first).toEqual({ answers: [{ selected: ['Preview'] }] })

    const second = manager.requestUserQuestion(managed, questions).catch((error: Error) => error)
    managed.backgroundTaskRegistry.get('agent')!.status = 'completed'
    manager.publishBackgroundActivity(managed)
    expect((await second).message).toContain('last agent finished')
    expect(manager.getPendingQuestion(managed.id)).toBeNull()
  })
  it('background-only questions are explicitly skippable without stopping unrelated background agents', async () => {
    const { manager, managed, events } = harness()
    manager.keepBackgroundTasksAlive = true
    managed.isProcessing = false
    managed.backgroundTaskRegistry.set('agent', { taskId: 'agent', startTime: 1, status: 'running', kind: 'agent' })
    const pending = manager.requestUserQuestion(managed, questions)
    const request = manager.getPendingQuestion(managed.id)
    expect(request.cancelAction).toBe('skip')
    manager.respondToQuestion(managed.id, request.requestId, { cancelled: true, answers: [] })
    expect(await pending).toEqual({ cancelled: true, answers: [] })
    expect(managed.stopRequested).toBeFalsy()
    expect(events.some(event => event.type === 'interrupted')).toBe(false)
    expect(managed.backgroundTaskRegistry.get('agent')!.status).toBe('running')
  })
  it('refreshes Cancel agent to Skip after foreground completion and decides from the current server state', async () => {
    const { manager, managed, events } = harness()
    manager.keepBackgroundTasksAlive = true
    managed.backgroundTaskRegistry.set('agent', { taskId: 'agent', startTime: 1, status: 'running', kind: 'agent' })
    const pending = manager.requestUserQuestion(managed, questions)
    expect(manager.getPendingQuestion(managed.id).cancelAction).toBe('stop')
    manager.setProcessing(managed, false)
    const request = manager.getPendingQuestion(managed.id)
    expect(request.cancelAction).toBe('skip')
    manager.respondToQuestion(managed.id, request.requestId, { cancelled: true, answers: [], cancelAction: 'stop' })
    expect(await pending).toEqual({ cancelled: true, answers: [] })
    expect(managed.stopRequested).toBeFalsy()
    expect(events.some(event => event.type === 'interrupted')).toBe(false)
  })
  it('an idle shell is not an agent runtime and cannot open questions or receive stale answers', () => {
    const { manager, managed } = harness()
    manager.keepBackgroundTasksAlive = true
    managed.isProcessing = false
    managed.backgroundTaskRegistry.set('shell', { taskId: 'shell', startTime: 1, status: 'running', kind: 'shell' })
    expect(() => manager.requestUserQuestion(managed, questions)).toThrow('not running')
    expect(() => manager.respondToQuestion(managed.id, 'stale', { cancelled: true, answers: [] })).toThrow('no longer waiting')
    expect(manager.getPendingQuestion(managed.id)).toBeNull()
  })
})
