import { messageToStored } from '@craft-agent/core/types'
import { beforeEach, afterEach, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from './SessionManager'
import { saveSession, loadSession } from '@craft-agent/shared/sessions'
let sm: any, managed: any, dir: string, events: any[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'craft-tool-settle-')); sm = new SessionManager(); events = []
  managed = createManagedSession({ id: 'test', name: 'Fixture' }, { id: 'ws', name: 'Fixture', rootPath: dir, createdAt: 1 } as any, { messagesLoaded: true })
  sm.sessions.set('test', managed); sm.persistSession = () => {}; sm.keepBackgroundTasksAlive = false
  sm.setEventSink((_a: unknown, _b: unknown, event: unknown) => events.push(event))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const tool = (id: string, rest: any = {}) => ({ id, role: 'tool', content: '', timestamp: 1, toolUseId: id, toolName: 'Bash', toolStatus: 'executing', ...rest })
it('settles foreground tools on the server and renderer while protecting a live background descendant', () => {
  managed.messages = [tool('parent', { toolName: 'Agent' }), tool('shell', { isBackground: true, shellId: 'shell-id', toolStatus: 'backgrounded', parentToolUseId: 'parent' })]
  managed.backgroundTaskRegistry.set('shell-id', { toolUseId: 'shell', status: 'running', kind: 'shell' })
  sm.settleSessionTools(managed)
  expect(managed.messages.map((m: any) => m.toolStatus)).toEqual(['completed', 'backgrounded'])
})
it('does not mutate a user message when an untracked completion has no tool identity', async () => {
  managed.messages = [{ id: 'user', role: 'user', content: 'keep me', timestamp: 1 }]
  await sm.processEvent(managed, { type: 'task_completed', taskId: 'untracked', status: 'completed' })
  expect(managed.messages[0]).toEqual({ id: 'user', role: 'user', content: 'keep me', timestamp: 1 })
  expect(events.filter(e => e.type === 'tool_result')).toHaveLength(0)
})
it('late and duplicate background notifications keep terminal errors and retain detailed output', async () => {
  managed.messages = [tool('launch')]
  await sm.processEvent(managed, { type: 'task_backgrounded', toolUseId: 'launch', taskId: 'job' })
  await sm.processEvent(managed, { type: 'task_completed', toolUseId: 'launch', taskId: 'job', status: 'failed', summary: 'Task failed' })
  await sm.processEvent(managed, { type: 'tool_result', toolUseId: 'launch', toolName: 'Bash', result: 'Detailed actual output' })
  await sm.processEvent(managed, { type: 'task_completed', toolUseId: 'launch', taskId: 'job', status: 'failed', summary: 'Task failed' })
  await sm.processEvent(managed, { type: 'task_backgrounded', toolUseId: 'launch', taskId: 'job' })
  expect(managed.messages[0]).toMatchObject({ toolStatus: 'error', isError: true })
  expect(managed.messages[0].toolResult).toContain('Task failed'); expect(managed.messages[0].toolResult).toContain('Detailed actual output')
  expect(managed.backgroundTaskRegistry.get('job').status).toBe('failed')
})
it('links an early task completion when its later background event finally identifies the launch tool', async () => {
  managed.messages = [tool('launch')]
  await sm.processEvent(managed, { type: 'task_completed', taskId: 'fast', status: 'failed', summary: 'Early failure' })
  await sm.processEvent(managed, { type: 'task_backgrounded', taskId: 'fast', toolUseId: 'launch' })
  const canonical = events.filter(e => e.type === 'task_completed').at(-1)
  expect(canonical).toMatchObject({ toolUseId: 'launch', status: 'failed' })
  expect(managed.messages[0]).toMatchObject({ toolStatus: 'error', toolResult: 'Early failure' })
})
it('normalizes only history before a top-level final, keeping disk timestamps, attachments and newer calls unchanged', async () => {
  const messages = [tool('old'), { id: 'sub-final', role: 'assistant', parentToolUseId: 'old', content: 'subagent done', timestamp: 2 }, tool('middle', { timestamp: 3 }), { id: 'final', role: 'assistant', content: 'done', timestamp: 4 }, tool('newer', { timestamp: 5 })]
  await saveSession({ id: 'test', workspaceRootPath: dir, createdAt: 1, lastUsedAt: 12, name: 'Keep name', messages: messages.map(message => messageToStored(message as any)), tokenUsage: { inputTokens: 11, outputTokens: 4 } } as any)
  const diskBefore = loadSession(dir, 'test')!
  managed.messagesLoaded = false; await sm.loadMessagesFromDisk(managed)
  expect(managed.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.toolStatus)).toEqual(['completed', 'completed', 'executing'])
  expect(managed.tokenUsage.inputTokens).toBe(11)
  expect(loadSession(dir, 'test')!.lastUsedAt).toBe(diskBefore.lastUsedAt)
  expect(loadSession(dir, 'test')!.messages[0]!.toolStatus).toBe('executing')
  expect(events).toHaveLength(0)
})
it('does not treat a subagent final as the parent turn completing', async () => {
  await saveSession({ id: 'test', workspaceRootPath: dir, createdAt: 1, lastUsedAt: 1, messages: [tool('parent'), { id: 'sub', role: 'assistant', content: 'child done', parentToolUseId: 'parent', timestamp: 2 }].map(message => messageToStored(message as any)) } as any)
  managed.messagesLoaded = false; await sm.loadMessagesFromDisk(managed)
  expect(managed.messages[0].toolStatus).toBe('executing')
})

it('persists a genuine running shell as backgrounded through its launch acknowledgement', async () => {
  managed.messages = [tool('shell')]
  await sm.processEvent(managed, { type: 'shell_backgrounded', shellId: 'job', toolUseId: 'shell' })
  await sm.processEvent(managed, { type: 'tool_result', toolUseId: 'shell', toolName: 'Bash', result: 'Command running in background. shell_id: job' })
  expect(managed.messages[0]).toMatchObject({ toolStatus: 'backgrounded', isBackground: true, shellId: 'job' })
  expect(managed.backgroundTaskRegistry.get('job').status).toBe('running')
  sm.settleSessionTools(managed)
  expect(managed.messages[0].toolStatus).toBe('backgrounded')
})
