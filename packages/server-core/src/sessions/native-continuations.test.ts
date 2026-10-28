import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionManager, createManagedSession } from './SessionManager'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
async function settled(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await tick() }
  throw new Error('Continuation did not settle')
}

describe('server native continuation ownership', () => {
  let sm: any, managed: any, root: string, ui: any[], completions: any[], persisted: any[]
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'native-sm-'))
    sm = new SessionManager()
    sm.decisionFeatureActive = () => false
    sm.applyTurnOutcome = async () => {}
    sm.refreshTitleIfDrifted = async () => {}
    sm.keepBackgroundTasksAlive = true
    sm.persistSession = (m: any) => persisted.push(m.messages.map((message: any) => ({ ...message })))
    sm.flushSession = async () => {}
    sm.loadSessionSources = async () => []
    sm.markSessionRead = async () => {}
    sm.isSessionBeingViewed = () => true
    ui = []; completions = []; persisted = []
    sm.setEventSink((event: any) => ui.push(event))
    sm.onSessionComplete((event: any) => completions.push(event))
    managed = createManagedSession({ id: 'native', name: 'Existing', hasUnread: false },
      { id: 'ws', name: 'Test', rootPath: root, createdAt: Date.now() } as any, { messagesLoaded: true })
    managed.messages = [{ id: 'original', role: 'user', content: '/ship-plan SAP-4410', timestamp: 1 }]
    managed.turnFromUser = true
    sm.sessions.set(managed.id, managed)
  })
  afterEach(() => { sm.clearIdleRuntimeTimer?.(managed); rmSync(root, { recursive: true, force: true }) })

  function backend(batches: any[][]) {
    let runs = 0
    const agent = {
      hasPendingBackgroundTurn: () => batches.length > 0,
      resumeBackgroundTurn: async function* () { runs++; for (const event of batches.shift()!) yield event },
      getSessionId: () => 'sdk',
    }
    managed.agent = agent
    return { agent, runs: () => runs }
  }

  it('persists autonomous output and usage once, without adding a hidden user message', async () => {
    const b = backend([[{ type: 'text_complete', text: 'PLAN_COMPLETE', isIntermediate: false },
      { type: 'complete', usage: { inputTokens: 20, outputTokens: 7 } }]])
    sm.resumeBackgroundTurn(managed)
    await settled(() => completions.length === 1)
    expect(managed.messages.filter((m: any) => m.role === 'user')).toHaveLength(1)
    expect(managed.messages.filter((m: any) => m.content === 'PLAN_COMPLETE')).toHaveLength(1)
    expect(persisted.some(messages => messages.some((m: any) => m.content === 'PLAN_COMPLETE'))).toBe(true)
    expect(managed.tokenUsage.outputTokens).toBe(7)
    expect(completions[0].fromUser).toBe(false)
    expect(b.runs()).toBe(1)
  })

  it('drains native work before queued owner messages and after asynchronous cleanup', async () => {
    const b = backend([[{ type: 'text_complete', text: 'native' }, { type: 'complete' }]])
    managed.isProcessing = true
    managed.messageQueue = [{ message: 'next', messageId: 'queued' }]
    const order: string[] = []
    const gate = Promise.withResolvers<void>()
    sm.getBrowserPaneManagerForSession = () => ({ clearVisualsForSession: async () => { order.push('cleanup'); await gate.promise }, unbindAllForSession: () => {} })
    sm.processNextQueuedMessage = () => { order.push('owner'); managed.messageQueue = [] }
    const cleanup = sm.onProcessingStopped(managed.id, 'complete')
    sm.resumeBackgroundTurn(managed)
    expect(b.runs()).toBe(0)
    gate.resolve(); await cleanup
    await settled(() => order.includes('owner'))
    expect(b.runs()).toBe(1)
    expect(managed.messages.some((m: any) => m.content === 'native')).toBe(true)
    expect(order.at(-1)).toBe('owner')
  })

  it('never adopts archived work, nor overtakes a pending accepted owner send', async () => {
    const b = backend([[{ type: 'complete' }]])
    managed.isArchived = true; sm.resumeBackgroundTurn(managed)
    managed.isArchived = false; managed.checkpointPendingSends = 1; sm.resumeBackgroundTurn(managed)
    await tick(); expect(b.runs()).toBe(0)
    managed.checkpointPendingSends = 0; sm.resumeBackgroundTurn(managed)
    await settled(() => b.runs() === 1 && !managed.isProcessing)
  })

  it('does not let an old awaited cleanup complete or dequeue against a newer generation', async () => {
    const gate = Promise.withResolvers<void>()
    managed.isProcessing = true
    sm.getBrowserPaneManagerForSession = () => ({ clearVisualsForSession: () => gate.promise })
    let dequeued = false
    sm.processNextQueuedMessage = () => { dequeued = true }
    const cleanup = sm.onProcessingStopped(managed.id, 'complete')
    managed.processingGeneration++; managed.isProcessing = true; managed.messageQueue = [{ message: 'new' }]
    gate.resolve(); await cleanup
    expect(dequeued).toBe(false)
    expect(managed.isProcessing).toBe(true)
    expect(ui.some((event: any) => event.type === 'complete')).toBe(false)
  })

  it('stops forwarding buffered events immediately after archive invalidates the turn', async () => {
    const gate = Promise.withResolvers<void>()
    managed.agent = { hasPendingBackgroundTurn: () => true, resumeBackgroundTurn: async function* () {
      yield { type: 'text_complete', text: 'before archive' }
      await gate.promise
      yield { type: 'text_complete', text: 'after archive' }
      yield { type: 'complete' }
    } }
    sm.resumeBackgroundTurn(managed)
    await settled(() => managed.messages.some((m: any) => m.content === 'before archive'))
    managed.isArchived = true; managed.stopEpoch++; managed.processingGeneration++; gate.resolve(); await tick()
    expect(managed.messages.some((m: any) => m.content === 'after archive')).toBe(false)
    expect(completions).toHaveLength(0)
  })

  it('does not inject a task-completion nudge for a native-capable runtime', async () => {
    backend([])
    managed.backgroundTaskRegistry.set('task', { taskId: 'task', status: 'running', startTime: 1 })
    let sends = 0; sm.sendMessage = async () => { sends++ }
    await sm.processEvent(managed, { type: 'task_completed', taskId: 'task', status: 'completed', launchedHere: true })
    expect(sends).toBe(0)
    expect(managed.backgroundTaskRegistry.get('task').status).toBe('completed')
  })
})
