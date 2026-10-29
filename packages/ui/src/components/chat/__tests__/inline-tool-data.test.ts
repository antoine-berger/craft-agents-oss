import { describe, expect, it } from 'bun:test'
import type { ActivityItem } from '../TurnCard'
import { capturedTodos, collaborationData, editChanges, getInlineToolData, inlineOutput, INLINE_OUTPUT_LIMIT, mcpToolTitle, numberedRead, subagentResult, todoStatusRows } from '../turn/inline-tool-data'

const activity = (overrides: Partial<ActivityItem> = {}): ActivityItem => ({
  id: 'tool-1', type: 'tool', status: 'completed', timestamp: 1, toolName: 'Bash', ...overrides,
})

describe('captured tool data', () => {
  it('retains Read offsets and strips SDK line numbers without inventing lines', () => {
    const data = getInlineToolData(activity({ toolName: 'Read', toolInput: { file_path: '/repo/main.ts', offset: 31 },
      content: '   31→const a = 1\n   32→return a' }))
    expect(data).toMatchObject({ title: 'Read 2 lines', path: '/repo/main.ts', output: 'const a = 1\nreturn a', startLine: 31 })
    expect(numberedRead('42 is a real value\nnot numbered', 8)).toEqual({ text: '42 is a real value\nnot numbered', startLine: 8 })
    expect(numberedRead('1\tactual TSV value\n2\tmore data', 8)).toEqual({ text: '1\tactual TSV value\n2\tmore data', startLine: 8 })
    expect(getInlineToolData(activity({ toolName: 'Read', content: '{"file":{"content":"x","startLine":90,"numLines":1}}' })))
      .toMatchObject({ title: 'Read 1 lines', startLine: 90, output: 'x' })
  })

  it('keeps images out of the text/code renderer and running reads truthful', () => {
    expect(getInlineToolData(activity({ toolName: 'Read', toolInput: { file_path: '/repo/photo.webp' }, content: 'image data' })))
      .toMatchObject({ kind: 'image', title: 'Read image' })
    expect(getInlineToolData(activity({ toolName: 'Read', status: 'running' })).title).toBe('Reading')
  })

  it('parses Bash output without losing stderr or converting failure to success', () => {
    expect(getInlineToolData(activity({ toolInput: { command: 'false', description: 'Verify' },
      content: '{"stdout":"start","stderr":"failed","exitCode":1}' })))
      .toMatchObject({ kind: 'code', title: 'Verify', preview: 'false', output: 'start\nfailed' })
  })

  it('preserves every valid MultiEdit and Codex patch while ignoring malformed entries', () => {
    expect(editChanges({ file_path: '/repo/a.ts', edits: [null, { old_string: 'a', new_string: 'b' }, { old_string: 1 },
      { old_string: 'c', new_string: '' }] })).toEqual([
      { path: '/repo/a.ts', original: 'a', modified: 'b' }, { path: '/repo/a.ts', original: 'c', modified: '' },
    ])
    expect(editChanges({ changes: [null, { path: '/repo/a.ts', diff: '@@ -1 +1 @@\n-a\n+b' }, { diff: 3 }] }))
      .toEqual([{ path: '/repo/a.ts', patch: '@@ -1 +1 @@\n-a\n+b' }])
    expect(getInlineToolData(activity({ toolName: 'Edit', toolInput: { old_string: null }, content: 'Could not edit' })).kind).toBe('generic')
  })

  it('bounds the inline preview while retaining the complete captured output', () => {
    const content = 'x'.repeat(INLINE_OUTPUT_LIMIT + 1)
    expect(inlineOutput(content)).toEqual({ text: content.slice(0, INLINE_OUTPUT_LIMIT), truncated: true })
    expect(getInlineToolData(activity({ content })).output).toHaveLength(content.length)
    expect(inlineOutput('x'.repeat(80_000)).truncated).toBe(false)
    expect(INLINE_OUTPUT_LIMIT).toBe(100_000)
  })

  it('handles plain, structured and malformed subagent results', () => {
    expect(subagentResult(activity({ content: '{"result":"Final answer","usage":{"output_tokens":4}}' }))).toBe('Final answer')
    expect(subagentResult(activity({ content: '[{"type":"text","text":"A"},{"type":"image"},{"type":"text","text":"B"}]' }))).toBe('A\n\nB')
    expect(subagentResult(activity({ content: '{ malformed' }))).toBe('{ malformed')
  })

  it('uses the specific captured preview for Linear and Context7 instead of all parameters', () => {
    expect(getInlineToolData(activity({ toolName: 'mcp__linear__get_issue', toolInput: { id: 'TEST-42', includeRelations: true }, content: '{}' })))
      .toMatchObject({ kind: 'mcp', title: 'Get issue', preview: 'TEST-42' })
    expect(getInlineToolData(activity({ toolName: 'mcp__context7__resolve-library-id', toolInput: { libraryName: 'react', query: 'hooks' } })))
      .toMatchObject({ kind: 'mcp', title: 'Resolve library id', preview: 'react' })
    expect(getInlineToolData(activity({ toolName: 'mcp__context7__get-library-docs', toolInput: { topic: 'state' } })).preview).toBe('state')
    expect(mcpToolTitle('mcp__linear__linear_getIssue')).toBe('Get issue')
  })

  it('renders recorded skill/plan tools without changing how they execute', () => {
    expect(getInlineToolData(activity({ toolName: 'Skill', toolInput: { skill: 'workspace:ship-plan' } })))
      .toMatchObject({ kind: 'status', title: 'Ship Plan', preview: 'Skill activated', output: '' })
    expect(getInlineToolData(activity({ toolName: 'EnterPlanMode' }))).toMatchObject({ kind: 'status', title: 'Enter plan mode' })
    expect(getInlineToolData(activity({ toolName: 'ExitPlanMode', toolInput: { plan: '# Actual plan' } })))
      .toMatchObject({ kind: 'markdown', title: 'Propose plan', defaultExpanded: true, output: '# Actual plan' })
    expect(getInlineToolData(activity({ toolName: 'Write', toolInput: { file_path: '/repo/file.md', content: '# Captured file\ntext' } })))
      .toMatchObject({ kind: 'write', title: 'Write 2 lines', output: '# Captured file\ntext' })
  })

  it('maps collaboration operations to real action/receiver states, not a generic JSON block', () => {
    const data = collaborationData(activity({ toolName: 'collab__wait', toolInput: { receiver_thread_ids: ['thread-1'], prompt: 'Wait here' },
      content: JSON.stringify({ status: 'completed', receiverThreadIds: ['thread-1'], receiverThreads: [{ id: 'thread-1', agentNickname: 'Ada', agentRole: 'reviewer' }],
        agentsStates: { 'thread-1': { status: 'running', message: 'Checking files' } } }) }))
    expect(data).toMatchObject({ title: 'Finished waiting for', status: 'completed', prompt: 'Wait here',
      receivers: [{ id: 'thread-1', nickname: 'Ada', role: 'reviewer', state: 'running', message: 'Checking files' }] })
    expect(collaborationData(activity({ toolName: 'spawn_agent', status: 'running', toolInput: { model: 'requested-model' } })))
      .toMatchObject({ title: 'Spawning', status: 'running', model: 'requested-model', receivers: [] })
    expect(collaborationData(activity({ toolName: 'collab__closeAgent', status: 'error' }))).toMatchObject({ title: 'Failed to close', status: 'error' })
    for (const [name, title] of [
      ['spawn_agent', 'Spawned'], ['send_input', 'Sent input to'], ['resume_agent', 'Resumed'],
      ['wait_agent', 'Finished waiting for'], ['close_agent', 'Closed'], ['interrupt_agent', 'Interrupted'],
    ]) {
      expect(collaborationData(activity({ toolName: name }))).toMatchObject({ title, status: 'completed' })
    }
    expect(collaborationData(activity({ toolName: 'unrelated', toolInput: { operation: 'wait' } }))).toBeUndefined()
  })

  it('retains captured todo state and reproduces separate completed/started rows', () => {
    const todos = [{ content: 'Investigate', status: 'completed' as const }, { content: 'Implement', status: 'in_progress' as const }]
    const write = activity({ toolName: 'TodoWrite', toolInput: { todos } })
    expect(getInlineToolData(write)).toMatchObject({ kind: 'todo', todos, title: 'Todo completed', preview: '1/2 completed' })
    expect(todoStatusRows(todos)).toEqual([
      { id: 'completed', title: 'Todo completed', preview: '1/2 completed' },
      { id: 'started', title: 'Todo started', preview: '2. Implement' },
    ])
    expect(capturedTodos(activity({ toolName: 'TodoRead', content: `Current todos:\n${JSON.stringify(todos)}` }))).toEqual(todos)
    expect(todoStatusRows([{ content: 'Done', status: 'completed' }])[0]?.title).toBe('Todo list completed')
    expect(getInlineToolData(activity({ toolName: 'TodoWrite', toolInput: { todos: [] } }))).toMatchObject({ kind: 'todo', title: 'Todo list created', preview: '0 todos' })
    expect(getInlineToolData(activity({ toolName: 'TodoWrite', toolInput: { todos: [null] } })).kind).toBe('generic')
    expect(getInlineToolData(activity({ toolName: 'TodoRead', content: 'not a todo list' })).kind).toBe('generic')
  })
})
