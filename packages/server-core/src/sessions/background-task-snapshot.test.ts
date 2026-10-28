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
