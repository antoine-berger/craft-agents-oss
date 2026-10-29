import { expect, it } from 'bun:test'
import { handleToolResult, handleTaskBackgrounded, handleTaskCompleted } from '../tool'
import { handleComplete } from '../session'
const tool = (id: string, rest: any = {}) => ({ id, role: 'tool', content: '', timestamp: 1, toolUseId: id, toolName: 'Bash', toolStatus: 'executing', ...rest })
const state = (messages: any[]): any => ({ session: { id: 'test', messages }, streaming: null })
it('keeps a background descendant alive when its foreground Agent is settled', () => {
  const input = state([tool('parent', { toolName: 'Agent' }), tool('shell', { isBackground: true, shellId: 'job', toolStatus: 'backgrounded', parentToolUseId: 'parent' })])
  const result = handleToolResult(input, { type: 'tool_result', sessionId: 'test', toolUseId: 'parent', result: 'No result captured', isError: false } as any)
  expect(result.session.messages.map(m => m.toolStatus)).toEqual(['completed', 'backgrounded'])
  expect(handleComplete(result, { type: 'complete', sessionId: 'test', backgroundTasksAlive: true } as any).state.session.messages[1]!.toolStatus).toBe('backgrounded')
})
it('preserves a terminal failure and detailed late output through duplicate completions and starts', () => {
  let current = state([tool('launch', { isBackground: true, taskId: 'job', toolStatus: 'error', isError: true, toolResult: 'Task failed' })])
  current = handleToolResult(current, { type: 'tool_result', sessionId: 'test', toolUseId: 'launch', result: 'Detailed output', isError: false } as any)
  current = handleTaskCompleted(current, { type: 'task_completed', sessionId: 'test', taskId: 'job', status: 'failed', summary: 'Task failed' } as any)
  current = handleTaskBackgrounded(current, { type: 'task_backgrounded', sessionId: 'test', toolUseId: 'launch', taskId: 'job' } as any)
  expect(current.session.messages[0]).toMatchObject({ toolStatus: 'error', isError: true })
  expect(current.session.messages[0].toolResult).toContain('Detailed output')
})
it('uses a server-resolved launch identity or shell ID for terminal notifications', () => {
  const shell = state([tool('shell', { isBackground: true, shellId: 'job', toolStatus: 'backgrounded' })])
  expect(handleTaskCompleted(shell, { type: 'task_completed', sessionId: 'test', taskId: 'job', status: 'completed', summary: 'Done' } as any).session.messages[0]!.toolStatus).toBe('completed')
  const resolved = handleTaskCompleted(state([tool('launch')]), { type: 'task_completed', sessionId: 'test', taskId: 'early', toolUseId: 'launch', status: 'failed', summary: 'Early failure' } as any)
  expect(resolved.session.messages[0]!.toolStatus).toBe('error')
})
