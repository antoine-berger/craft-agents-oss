import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from './SessionManager'

describe('server activity survives client disconnection', () => {
  let root: string
  let sm: SessionManager
  let managed: any
  let events: any[]
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'background-snapshot-'))
    sm = new SessionManager()
    managed = createManagedSession({ id: 'chat' }, { id: 'workspace', rootPath: root } as any, { messagesLoaded: true })
    events = []
    ;(sm as any).sessions.set('chat', managed)
    ;(sm as any).sendEvent = (event: unknown) => events.push(event)
    ;(sm as any).sendMessage = async () => {}
    ;(sm as any).keepBackgroundTasksAlive = true
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  const fire = async (event: any) => (sm as any).processEvent(managed, event)

  it('recovers agents, workflows and shells with their current progress', async () => {
    await fire({ type: 'task_backgrounded', taskId: 'agent', toolUseId: 'a', intent: 'Review' })
    await fire({ type: 'task_backgrounded', taskId: 'workflow', toolUseId: 'w', kind: 'workflow', workflowId: 'wf_1' })
    await fire({ type: 'shell_backgrounded', shellId: 'shell', toolUseId: 's', intent: 'Build' })
    await fire({ type: 'task_progress', toolUseId: 'a', elapsedSeconds: 42 })
    await fire({ type: 'task_activity', taskId: 'agent', summary: 'Checking tests', lastToolName: 'Bash', toolUses: 3 })
    await fire({ type: 'workflow_agent_completed', workflowId: 'wf_1' })
    const snapshot = (await sm.getSession('chat'))!
    expect(snapshot.backgroundTasks?.map(t => t.id)).toEqual(['agent', 'workflow', 'shell'])
    expect(snapshot.backgroundTasks?.[0]).toMatchObject({ type: 'agent', intent: 'Review', elapsedSeconds: 42, activity: { summary: 'Checking tests', lastToolName: 'Bash', toolUses: 3 } })
    expect(snapshot.backgroundTasks?.[1]).toMatchObject({ type: 'workflow', agentsCompleted: 1 })
    expect(snapshot.backgroundTasks?.[2]).toMatchObject({ type: 'shell', isSubagent: false })
    await fire({ type: 'task_completed', taskId: 'agent', status: 'completed' })
    expect(sm.getSessionSnapshot('chat')?.backgroundTasks?.map(t => t.id)).toEqual(['workflow', 'shell'])
    expect(snapshot.backgroundTasks?.[0]?.status).toBe('running') // Captured state is immutable.
  })

  it('returns partial text without persisting it and flushes queued deltas before the snapshot', async () => {
    await fire({ type: 'text_delta', text: 'Already generated ', turnId: 'turn' })
    const snapshot = (await sm.getSession('chat'))!
    expect(events.filter(e => e.type === 'text_delta').map(e => e.delta).join('')).toBe('Already generated ')
    expect(snapshot.messages).toHaveLength(1)
    expect(snapshot.messages[0]).toMatchObject({ content: 'Already generated ', turnId: 'turn', isStreaming: true, isPending: true })
    expect(managed.messages).toHaveLength(0)
    expect(sm.getSessions()[0]?.messages).toEqual([])
    await fire({ type: 'text_complete', text: 'Already generated reply', turnId: 'turn' })
    const completed = (await sm.getSession('chat'))!
    expect(completed.messages).toHaveLength(1)
    expect(completed.messages[0]?.content).toBe('Already generated reply')
    expect(completed.messages[0]?.isStreaming).not.toBe(true)
  })

  it('returns the actual running agents to a newly connected client and pushes terminal updates', async () => {
    await fire({ type: 'task_backgrounded', taskId: 'agent', toolUseId: 'a' })
    await fire({ type: 'task_backgrounded', taskId: 'workflow', toolUseId: 'w', kind: 'workflow' })
    await fire({ type: 'task_backgrounded', taskId: 'monitor', toolUseId: 'm', kind: 'task' })
    await fire({ type: 'shell_backgrounded', shellId: 'server', toolUseId: 's' })
    expect(sm.getSessions()[0]?.backgroundAgentCount).toBe(2)
    expect(sm.getSessionSnapshot('chat')?.isProcessing).toBe(false)
    // No renderer subscribes during the remaining task events.
    await fire({ type: 'task_completed', taskId: 'agent', status: 'completed' })
    expect(sm.getSessionSnapshot('chat')?.backgroundAgentCount).toBe(1)
    await fire({ type: 'task_completed', taskId: 'workflow', status: 'failed' })
    expect(sm.getSessions()[0]?.backgroundAgentCount).toBe(0)
    expect(events.filter(e => e.type === 'session_metadata_changed').map(e => e.changes.backgroundAgentCount)).toEqual([1, 2, 2, 1, 0])
  })

  it('does not carry running state across a server restart when no agents survive', async () => {
    await fire({ type: 'task_backgrounded', taskId: 'agent', toolUseId: 'a' })
    const fresh = createManagedSession({ id: 'chat' }, managed.workspace)
    ;(sm as any).sessions.set('chat', fresh)
    expect(sm.getSessionSnapshot('chat')?.backgroundAgentCount).toBe(0)
  })
})
