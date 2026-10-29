import * as React from 'react'
import { describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ActivityItem } from '../TurnCard'
import { isActivityGroup, type ActivityGroup } from '../turn-utils'

// Keep this isolated from the rest of the suite: its concern is ownership/disclosure state,
// not Markdown's PDF worker or asynchronous highlighting.
mock.module('../../markdown', () => ({
  Markdown: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  CodeBlock: ({ code }: { code: string }) => React.createElement('pre', null, code),
}))
const codeViewers = await import('../../code-viewer')
mock.module('../../code-viewer', () => ({ ...codeViewers,
  ShikiDiffViewer: () => React.createElement('div', { 'data-diff-viewer': 'true' }),
  UnifiedDiffViewer: () => React.createElement('div', { 'data-diff-viewer': 'true' }),
}))
const { InlineDisclosure, InlineToolBlock } = await import('../turn/InlineToolBlock')
const { subagentChildren, InlineSubagentBlock } = await import('../turn/InlineSubagentBlock')
const el = React.createElement
const activity = (overrides: Partial<ActivityItem> = {}): ActivityItem => ({
  id: 'tool-1', type: 'tool', status: 'completed', timestamp: 1, toolName: 'Bash', ...overrides,
})

function withExpandedDisclosures(render: () => string): string {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => 'true', setItem: () => {} } })
  try { return render() } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
}

describe('recursive inline subagents', () => {
  const group: ActivityGroup = {
    type: 'group', parent: activity({ id: 'parent', toolUseId: 'p', toolName: 'Agent', toolInput: { prompt: 'Do work', model: 'sonnet' } }),
    children: [
      activity({ id: 'comment', type: 'intermediate', parentId: 'p', content: 'Reading now' }),
      activity({ id: 'nested', toolUseId: 'n', parentId: 'p', toolName: 'Agent', timestamp: 2 }),
      activity({ id: 'nested-answer', type: 'intermediate', parentId: 'n', content: 'Nested answer', timestamp: 3 }),
    ],
  }

  it('reuses ownership without recursively repeating a missing-parent group', () => {
    const original = JSON.stringify(group)
    const children = subagentChildren(group)
    expect(children).toHaveLength(2)
    expect(children[0]).toMatchObject({ id: 'comment', parentId: undefined })
    expect(isActivityGroup(children[1]!)).toBe(true)
    const nested = children[1] as ActivityGroup
    expect(nested.children.map(child => child.id)).toEqual(['nested-answer'])
    expect(subagentChildren(nested)).toMatchObject([{ id: 'nested-answer', parentId: undefined }])
    expect(JSON.stringify(group)).toBe(original)
  })

  it('search and annotation focus reveal child messages without a stored expanded state', () => {
    const search = renderToStaticMarkup(el(InlineSubagentBlock, { group, sessionId: 's', searchQuery: 'Nested answer' }))
    expect(search).toContain('Nested answer')
    expect(search.match(/aria-expanded="true"/g)).toHaveLength(2)
    const annotation = renderToStaticMarkup(el(InlineSubagentBlock, { group, sessionId: 's', openMessageId: 'nested-answer' }))
    expect(annotation).toContain('Nested answer')
  })

  it('a completed launch acknowledgement does not override a still-running child', () => {
    const running: ActivityGroup = { ...group, parent: { ...group.parent, content: 'Launch acknowledged' },
      children: [activity({ id: 'working', status: 'running', parentId: 'p' })] }
    const html = renderToStaticMarkup(el(InlineSubagentBlock, { group: running, sessionId: 's' }))
    expect(html).not.toContain('Launch acknowledged')
    expect(html).toContain('Requested model')
  })

  it('retains the captured leaf below the indentation limit instead of discarding the deep group', () => {
    const children = Array.from({ length: 14 }, (_, index) => activity({ id: `agent-${index + 1}`, toolName: 'Agent', toolUseId: `p${index + 1}`, parentId: `p${index}`, timestamp: index + 2 }))
    children.push(activity({ id: 'leaf', type: 'intermediate', content: 'DEEPEST_CAPTURED_MESSAGE', parentId: 'p14', timestamp: 30 }))
    const deep: ActivityGroup = { type: 'group', parent: activity({ id: 'root', toolName: 'Agent', toolUseId: 'p0' }), children }
    const html = renderToStaticMarkup(el(InlineSubagentBlock, { group: deep, sessionId: 'deep', searchQuery: 'DEEPEST_CAPTURED_MESSAGE' }))
    expect(html.split('DEEPEST_CAPTURED_MESSAGE')).toHaveLength(2)
  })

  it('does not lose cyclic orphan records beside a legitimate nested group', () => {
    const cyclic: ActivityGroup = { ...group, children: [...group.children,
      activity({ id: 'cycle-a', toolName: 'Agent', toolUseId: 'a', parentId: 'b' }),
      activity({ id: 'cycle-b', toolName: 'Agent', toolUseId: 'b', parentId: 'a' }),
      activity({ id: 'cycle-leaf', type: 'intermediate', content: 'CYCLIC_CAPTURED_MESSAGE', parentId: 'a' }),
    ] }
    const html = renderToStaticMarkup(el(InlineSubagentBlock, { group: cyclic, sessionId: 'cycle', searchQuery: 'CYCLIC_CAPTURED_MESSAGE' }))
    expect(html).toContain('CYCLIC_CAPTURED_MESSAGE')
  })
})

it('the disclosure exposes its state and escapes captured text', () => {
  const html = renderToStaticMarkup(el(InlineDisclosure, { id: 'danger', title: 'Tool', forceExpanded: true }, '<script>alert(1)</script>'))
  expect(html).toContain('aria-expanded="true"')
  expect(html).toContain('&lt;script&gt;')
  expect(html).not.toContain('<script>')
})

it('ordinary previews are inside the toggle, while a file-open action stays outside it', () => {
  const ordinary = renderToStaticMarkup(el(InlineDisclosure, { id: 'command', title: 'Bash', preview: 'COMMAND_PREVIEW' }))
  expect(ordinary.match(/<button[^>]*aria-expanded[^>]*>([\s\S]*?)<\/button>/)?.[1]).toContain('COMMAND_PREVIEW')
  const file = renderToStaticMarkup(el(InlineDisclosure, { id: 'file', title: 'Read', previewInteractive: true,
    preview: el('button', { type: 'button' }, 'FILE_ACTION') }))
  expect(file.match(/<button[^>]*aria-expanded[^>]*>([\s\S]*?)<\/button>/)?.[1]).not.toContain('FILE_ACTION')
  expect(file).not.toMatch(/<button[^>]*aria-expanded[^>]*>[^]*<button[^]*<\/button><\/button>/)
})

it('Read/Bash use the real chat highlighter in a chromeless 12px wrapper, with native Read rows', () => {
  const html = withExpandedDisclosures(() => renderToStaticMarkup(el(InlineToolBlock, { activity: activity({ toolName: 'Read',
    toolInput: { file_path: '/repo/main.ts', offset: 5 }, content: '5→const a = 1\n6→return a' }) })))
  expect(html).toContain('data-code-appearance="chat"')
  expect(html).toContain('hljs-keyword')
  expect(html).toContain('text-[12px]')
  expect(html).toContain('w-12 shrink-0 select-none px-2 py-1')
  expect(html).toContain('leading-4')
  expect(html).not.toContain('group/code')
  const bash = withExpandedDisclosures(() => renderToStaticMarkup(el(InlineToolBlock, { activity: activity({ content: 'echo "$HOME"' }) })))
  expect(bash).toContain('data-code-appearance="chat"')
  expect(bash).toContain('hljs-variable')
})

it('MultiEdit starts with compact per-edit controls and does not mount all diff renderers', () => {
  const html = withExpandedDisclosures(() => renderToStaticMarkup(el(InlineToolBlock, { activity: activity({ toolName: 'MultiEdit',
    toolInput: { file_path: '/repo/main.ts', edits: [{ old_string: 'original A', new_string: 'new A' }, { old_string: 'original B', new_string: 'new B' }] } }) })))
  expect(html).toContain('Edit 1')
  expect(html).toContain('Edit 2')
  expect(html).toContain('original A')
  expect(html.match(/aria-expanded="false"/g)).toHaveLength(2)
  expect(html).not.toContain('data-diff-viewer')
})

it('TodoWrite renders task/status rows and a checklist rather than generic JSON', () => {
  const html = withExpandedDisclosures(() => renderToStaticMarkup(el(InlineToolBlock, { activity: activity({ toolName: 'TodoWrite', toolInput: {
    todos: [{ content: 'Investigate', status: 'completed' }, { content: 'Implement', status: 'in_progress' }],
  } }) })))
  expect(html).toContain('Todo completed')
  expect(html).toContain('Todo started')
  expect(html).toContain('line-through')
  expect(html).toContain('Investigate')
  expect(html).not.toContain('&quot;todos&quot;')
})
