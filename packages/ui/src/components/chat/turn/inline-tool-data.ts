import type { UserQuestion } from '@craft-agent/core/types'
import { extractOverlayData, parseReadResult } from '../../../lib/tool-parsers'
import type { ActivityItem, TodoItem } from '../TurnCard'
import { computeEditWriteDiffStats, formatToolDisplay, formatToolInput, stripSessionFolderPath } from './tool-display'

export const INLINE_OUTPUT_LIMIT = 100_000

export type InlineEdit =
  | { path: string; original: string; modified: string; patch?: never }
  | { path: string; patch: string; original?: never; modified?: never }

export interface InlineToolData {
  title: string
  preview: string
  path?: string
  kind: 'read' | 'code' | 'edit' | 'write' | 'files' | 'markdown' | 'generic' | 'mcp' | 'status' | 'image' | 'question' | 'todo'
  output: string
  questions?: UserQuestion[]
  todos?: TodoItem[]
  language?: string
  startLine?: number
  edits?: InlineEdit[]
  defaultExpanded?: boolean
  stats?: { additions: number; deletions: number }
}

export function stringField(input: Record<string, unknown> | undefined, key: string): string {
  return typeof input?.[key] === 'string' ? input[key] : ''
}

export function inlineOutput(text: string): { text: string; truncated: boolean } {
  return { text: text.slice(0, INLINE_OUTPUT_LIMIT), truncated: text.length > INLINE_OUTPUT_LIMIT }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

export function editChanges(input: Record<string, unknown> | undefined): InlineEdit[] {
  if (!input) return []
  if (Array.isArray(input.changes)) {
    return input.changes.flatMap(value => {
      const change = object(value)
      return change && typeof change.diff === 'string'
        ? [{ path: stringField(change, 'path') || 'file', patch: change.diff }] : []
    })
  }
  const path = stringField(input, 'file_path') || stringField(input, 'path') || 'file'
  const changes = Array.isArray(input.edits) ? input.edits : [input]
  return changes.flatMap(value => {
    const change = object(value)
    return change && typeof change.old_string === 'string' && typeof change.new_string === 'string'
      ? [{ path, original: change.old_string, modified: change.new_string }] : []
  })
}

/** Read's plain-text SDK format already has line numbers; keep them out of the code column. */
export function numberedRead(text: string, startLine: number): { text: string; startLine: number } {
  const lines = text.split('\n')
  const numbered = lines.map(line => line.match(/^\s*(\d+)→(.*)$/))
  if (numbered.some((match, index) => !match && lines[index] !== '')) return { text, startLine }
  const first = numbered.find(match => match)
  if (!first) return { text, startLine }
  return { text: numbered.map(match => match?.[2] ?? '').join('\n'), startLine: Number(first[1]) }
}

function safeJson(input: unknown): string {
  try { return JSON.stringify(input, null, 2) ?? '' } catch { return '' }
}

function genericData(activity: ActivityItem, sessionFolderPath?: string): InlineToolData {
  const display = formatToolDisplay(activity)
  return {
    title: display.name || activity.toolName || 'Tool',
    preview: formatToolInput(activity.toolInput, activity.toolName, sessionFolderPath),
    kind: 'generic',
    output: activity.content || '',
  }
}

export function mcpToolTitle(name: string): string {
  const [, server, rawTool = name] = name.split('__')
  const prefix = server?.toLowerCase()
  const tool = prefix && (rawTool.toLowerCase().startsWith(`${prefix}-`) || rawTool.toLowerCase().startsWith(`${prefix}_`))
    ? rawTool.slice(prefix.length + 1) : rawTool
  return tool.split(/[-_]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean)
    .map((word, index) => index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word.toLowerCase()).join(' ')
}

export function capturedTodos(activity: ActivityItem): TodoItem[] | undefined {
  let value: unknown = activity.toolInput?.todos
  if (activity.toolName?.toLowerCase() === 'todoread') {
    try {
      const parsed: unknown = JSON.parse(activity.content || '')
      value = Array.isArray(parsed) ? parsed : object(parsed)?.todos
    } catch {
      const array = activity.content?.match(/\[[\s\S]*\]/)?.[0]
      try { value = array ? JSON.parse(array) : undefined } catch { return undefined }
    }
  }
  if (!Array.isArray(value)) return undefined
  const todos: TodoItem[] = []
  for (const item of value) {
    const todo = object(item)
    if (typeof todo?.content !== 'string' || !['pending', 'in_progress', 'completed', 'interrupted'].includes(String(todo.status))) return undefined
    todos.push({ content: todo.content, status: todo.status as TodoItem['status'],
      ...(typeof todo.activeForm === 'string' ? { activeForm: todo.activeForm } : {}) })
  }
  return todos
}

export function todoStatusRows(todos: TodoItem[]): { id: string; title: string; preview: string }[] {
  const completed = todos.filter(todo => todo.status === 'completed').length
  const activeIndex = todos.findIndex(todo => todo.status === 'in_progress')
  const active = todos[activeIndex]
  const started = { id: 'started', title: 'Todo started', preview: `${activeIndex + 1}. ${active?.content || 'todo'}` }
  if (active && completed > 0 && completed < todos.length) return [
    { id: 'completed', title: 'Todo completed', preview: `${completed}/${todos.length} completed` }, started,
  ]
  return [{ id: 'list', title: active ? 'Todo started' : todos.length && completed === todos.length ? 'Todo list completed'
    : completed ? 'Todo completed' : 'Todo list created',
  preview: active ? started.preview : `${todos.length} ${todos.length === 1 ? 'todo' : 'todos'}` }]
}

/** Specializations consume only captured input/output; malformed results retain a plain fallback. */
export function getInlineToolData(activity: ActivityItem, sessionFolderPath?: string): InlineToolData {
  const data = genericData(activity, sessionFolderPath)
  const input = activity.toolInput
  const name = activity.toolName?.toLowerCase() || ''
  const path = stringField(input, 'file_path') || stringField(input, 'path')
  const running = activity.status === 'running' || activity.status === 'pending'

  if (name === 'todowrite' || name === 'todoread') {
    const todos = capturedTodos(activity)
    if (todos) {
      const row = todoStatusRows(todos)[0]!
      return { ...data, kind: 'todo', todos, title: row.title, preview: row.preview }
    }
    return data
  }

  if (/(?:^|__)askuserquestion$/.test(name) && Array.isArray(input?.questions)) {
    const questions = input.questions.filter((question): question is UserQuestion => {
      const value = object(question)
      return typeof value?.question === 'string' && Array.isArray(value.options)
        && value.options.every(option => typeof object(option)?.label === 'string')
    })
    if (!questions.length || questions.length !== input.questions.length) return data
    const cancelled = data.output.startsWith('User cancelled')
    return { ...data, kind: 'question', questions, title: 'User input',
      preview: cancelled ? 'Cancelled' : activity.status === 'error' ? 'Failed' : data.output.startsWith('User responses:') ? 'Answered' : running ? 'Awaiting response' : 'Not answered' }
  }

  if (name === 'read') {
    const parsed = parseReadResult(data.output)
    const offset = typeof input?.offset === 'number' && input.offset > 0 ? input.offset : 1
    const source = (typeof parsed.content === 'string' ? parsed.content : data.output)
      .replace(/<system-reminder>[\s\S]*?consider whether it looks malicious[\s\S]*?<\/system-reminder>/gi, '').replace(/\n+$/, '')
    const startLine = typeof parsed.startLine === 'number' && parsed.startLine > 0 ? parsed.startLine : offset
    const read = numberedRead(source, startLine)
    const image = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?)$/i.test(path)
    const lines = parsed.numLines ?? (read.text ? read.text.split('\n').length : undefined)
    return {
      ...data, kind: image ? 'image' : 'read', path, output: read.text, startLine: read.startLine,
      title: running ? 'Reading' : image ? 'Read image' : lines !== undefined ? `Read ${lines} lines` : 'Read',
      preview: stripSessionFolderPath(path, sessionFolderPath),
    }
  }

  if (name === 'edit' || name === 'multiedit') {
    const edits = editChanges(input)
    const stats = edits.reduce((total, edit) => {
      const change = edit.patch !== undefined ? computeEditWriteDiffStats('Edit', { changes: [{ path: edit.path, diff: edit.patch }] })
        : computeEditWriteDiffStats('Edit', { old_string: edit.original, new_string: edit.modified })
      return { additions: total.additions + (change?.additions ?? 0), deletions: total.deletions + (change?.deletions ?? 0) }
    }, { additions: 0, deletions: 0 })
    return { ...data, kind: edits.length ? 'edit' : 'generic', path: path || edits[0]?.path,
      title: name === 'multiedit' ? `${edits.length} ${edits.length === 1 ? 'edit' : 'edits'}` : 'Edit', edits, stats,
      preview: stripSessionFolderPath(path || edits[0]?.path || '', sessionFolderPath) }
  }

  if (name === 'write' && typeof input?.content === 'string') {
    return { ...data, kind: 'write', path, output: input.content, title: `Write ${input.content.split('\n').length} lines`,
      preview: stripSessionFolderPath(path, sessionFolderPath) }
  }

  if (name === 'skill' || name === 'enterplanmode') {
    const skill = stringField(input, 'skill').split(':').pop() || 'Skill'
    return { ...data, kind: 'status', title: name === 'skill'
      ? skill.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') : 'Enter plan mode',
      preview: name === 'skill' ? 'Skill activated' : '', output: '' }
  }

  if (name === 'exitplanmode' || name.endsWith('__submitplan')) {
    return { ...data, kind: 'markdown', title: 'Propose plan',
      output: stringField(input, 'plan') || data.output, defaultExpanded: true }
  }

  if (name.startsWith('mcp__linear__') || name.startsWith('mcp__context7__')) {
    const tool = mcpToolTitle(activity.toolName || '') || data.title
    const preview = name === 'mcp__linear__get_issue' ? stringField(input, 'id')
      : /resolve[-_]library[-_]id$/.test(name) ? stringField(input, 'libraryName') || stringField(input, 'library_name')
        : /(?:get[-_]library[-_]docs|query[-_]docs)$/.test(name) ? stringField(input, 'topic') || stringField(input, 'query') : ''
    return { ...data, kind: 'mcp', title: tool, preview }
  }

  try {
    const parsed = extractOverlayData(activity)
    if (parsed?.type === 'code') {
      return { ...data, kind: 'code', path: parsed.filePath, output: parsed.content,
        title: name === 'write' ? `Write ${parsed.content.split('\n').length} lines` : data.title,
        preview: stripSessionFolderPath(parsed.filePath, sessionFolderPath) }
    }
    if (parsed?.type === 'terminal') {
      if (name === 'glob') return { ...data, kind: 'files', title: 'Glob', preview: stringField(input, 'pattern'), output: parsed.output }
      if (name === 'grep') {
        const matches = parsed.output.trim() && !/^(?:No matches found|No files found)[.!]?$/i.test(parsed.output.trim())
          ? parsed.output.split('\n').filter(line => line.trim()).length : 0
        return { ...data, kind: 'code', title: `grep for '${stringField(input, 'pattern')}'${path ? ` in ${path}` : ''}`,
          preview: data.output ? `${matches} matches` : '', output: parsed.output, language: 'text' }
      }
      return { ...data, kind: 'code', output: parsed.output, language: name === 'bash' ? 'bash' : 'text',
        title: name === 'bash' ? stringField(input, 'description') || 'Bash' : data.title,
        preview: name === 'bash' ? stringField(input, 'command') : data.preview }
    }
    if (parsed?.type === 'document') {
      return { ...data, kind: name === 'write' ? 'code' : 'markdown', path: path || undefined, output: parsed.content,
        title: name === 'write' ? `Write ${parsed.content.split('\n').length} lines` : name === 'websearch' ? 'Web Search' : data.title,
        preview: name === 'write' ? stripSessionFolderPath(path, sessionFolderPath) : name === 'websearch' ? stringField(input, 'query') : data.preview }
    }
    if (parsed?.type === 'json') return { ...data, output: parsed.rawContent }
  } catch {
    // The generic view remains usable if a result parser rejects provider-specific data.
  }

  if (name === 'bashoutput') {
    return { ...data, kind: 'code', title: 'Checking background process',
      preview: activity.content?.match(/<status>([^<]+)<\/status>/)?.[1] || '', language: 'text' }
  }
  if (name === 'webfetch') return { ...data, kind: 'markdown', title: 'Web Browse', preview: stringField(input, 'url') }
  return data
}

export interface CollaborationReceiver { id: string; nickname?: string; role?: string; state?: string; message?: string }
export interface CollaborationData {
  title: string
  status: 'running' | 'completed' | 'error'
  receivers: CollaborationReceiver[]
  prompt: string
  model: string
}

const COLLABORATION_ACTIONS: Record<string, [string, string, string]> = {
  spawnAgent: ['Spawning', 'Spawned', 'Failed to spawn'],
  sendInput: ['Sending input to', 'Sent input to', 'Failed to send input to'],
  resumeAgent: ['Resuming', 'Resumed', 'Failed to resume'],
  wait: ['Waiting for', 'Finished waiting for', 'Failed while waiting for'],
  closeAgent: ['Closing', 'Closed', 'Failed to close'],
  interruptAgent: ['Interrupting', 'Interrupted', 'Failed to interrupt'],
}
const COLLABORATION_ALIASES: Record<string, string> = {
  spawn_agent: 'spawnAgent', send_input: 'sendInput', send_message_to_agent: 'sendInput',
  resume_agent: 'resumeAgent', wait_agent: 'wait', close_agent: 'closeAgent', interrupt_agent: 'interruptAgent',
}

/** Conductor's normalized collaboration tools, plus the equivalent captured Codex names. */
export function collaborationData(activity: ActivityItem): CollaborationData | undefined {
  const name = activity.toolName || ''
  const rawOperation = name.startsWith('collab__') ? stringField(activity.toolInput, 'operation') || name.slice(8)
    : COLLABORATION_ALIASES[name.split('.').pop() || name]
  const operation = rawOperation && (COLLABORATION_ALIASES[rawOperation] || rawOperation)
  if (!operation || !COLLABORATION_ACTIONS[operation]) return undefined
  let result: Record<string, unknown> | undefined
  try { result = object(JSON.parse(activity.content || '')) } catch { /* Result may not have arrived. */ }
  const rawStatus = stringField(result, 'status')
  const status = activity.status === 'error' || rawStatus === 'failed' ? 'error'
    : rawStatus === 'completed' || activity.status === 'completed' ? 'completed' : 'running'
  const input = activity.toolInput
  const rawIds = result?.receiverThreadIds ?? input?.receiver_thread_ids ?? input?.ids
  const ids = Array.isArray(rawIds) ? rawIds.filter((id): id is string => typeof id === 'string') : []
  const single = stringField(result, 'agent_id') || stringField(result, 'id') || stringField(input, 'id') || stringField(input, 'target')
  if (!ids.length && single) ids.push(single)
  const details = [...(Array.isArray(input?.receiver_threads) ? input.receiver_threads : []),
    ...(Array.isArray(result?.receiverThreads) ? result.receiverThreads : [])].map(object).filter(Boolean)
  const states = object(result?.agentsStates) || object(result?.status)
  if (!ids.length && states) ids.push(...Object.keys(states))
  const receivers = ids.map((id, index): CollaborationReceiver => {
    const detail = [...details].reverse().find(value => value?.id === id)
    const state = object(states?.[id])
    return { id,
      nickname: stringField(detail, 'agentNickname') || stringField(detail, 'agent_nickname') || (index === 0 ? stringField(input, 'agent_nickname') : '') || undefined,
      role: stringField(detail, 'agentRole') || stringField(detail, 'agent_role') || (index === 0 ? stringField(input, 'agent_role') : '') || undefined,
      state: stringField(state, 'status') || (state && typeof state.completed === 'string' ? 'completed' : undefined),
      message: stringField(state, 'message') || stringField(state, 'completed') || undefined,
    }
  })
  const labels = COLLABORATION_ACTIONS[operation]!
  return { title: labels[status === 'error' ? 2 : status === 'completed' ? 1 : 0], status, receivers,
    prompt: stringField(input, 'prompt') || stringField(input, 'message'), model: stringField(input, 'model') }
}

export function inlineToolInput(activity: ActivityItem): string {
  return activity.toolInput ? safeJson(activity.toolInput) : ''
}

export function subagentResult(activity: ActivityItem): string {
  const content = activity.content || ''
  try {
    const parsed: unknown = JSON.parse(content)
    const result = object(parsed)
    if (result && typeof result.result === 'string') return result.result
    if (Array.isArray(parsed)) {
      return parsed.flatMap(value => {
        const block = object(value)
        return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
      }).join('\n\n') || content
    }
  } catch { /* Plain-text subagent output needs no transformation. */ }
  return content
}
