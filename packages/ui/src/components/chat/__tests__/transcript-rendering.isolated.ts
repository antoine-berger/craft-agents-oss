import { describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '../../tooltip'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('react-pdf', () => ({ Document: () => null, Page: () => null, pdfjs: { GlobalWorkerOptions: {} } }))
const { ResponseCard, TurnCard } = await import('../TurnCard')
const h = React.createElement
const render = (element: React.ReactElement) => renderToStaticMarkup(h(TooltipProvider, null, element))

describe('chat transcript rendering', () => {
  it('shows the first streamed word immediately in the opted-in chat', () => {
    const html = render(h(ResponseCard, {
      appearance: 'chat', text: 'Hello', isStreaming: true, streamStartTime: Date.now(),
    }))
    expect(html).toContain('Hello')
    expect(html).toContain('data-markdown-appearance="chat"')
    expect(html).not.toContain('<time')
  })

  it('keeps buffering unchanged for embedded hosts using the default renderer', () => {
    expect(render(h(ResponseCard, { text: 'Hello', isStreaming: true, streamStartTime: Date.now() }))).toBe('')
  })

  it('renders live commentary as prose between inline tools without a WorkLog', () => {
    const html = render(h(TurnCard, {
      appearance: 'chat', turnId: 'turn', isComplete: false, isStreaming: true,
      activities: [
        { id: 'before', type: 'intermediate', content: 'Before the tool', status: 'completed', timestamp: 1 },
        { id: 'tool', toolName: 'Read', toolUseId: 'read', type: 'tool', content: 'Read output', toolInput: { file_path: '/tmp/example.ts' }, status: 'completed', timestamp: 2 },
        { id: 'after', type: 'intermediate', content: 'After the tool', status: 'running', timestamp: 3 },
      ],
    }))
    expect(html.indexOf('Before the tool')).toBeLessThan(html.indexOf('example.ts'))
    expect(html.indexOf('example.ts')).toBeLessThan(html.indexOf('After the tool'))
    expect(html).not.toContain('data-search-exclude="true"')
    expect(html).not.toContain('<time')
  })

  it('keeps an interrupted tool error visible in the chat', () => {
    const html = render(h(TurnCard, {
      appearance: 'chat', turnId: 'turn', isComplete: true, isStreaming: false,
      activities: [{ id: 'failed', toolName: 'Bash', type: 'tool', content: 'Command failed', error: 'Command failed', toolInput: { command: 'false' }, status: 'error', timestamp: 1 }],
    }))
    expect(html).toContain('Bash')
    expect(html).toContain('Command failed')
  })

  it('reveals matching Thinking through a closed summary without changing its saved expansion', () => {
    const savedStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    const writes: string[] = []
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: () => 'false', setItem: (key: string) => writes.push(key),
    } })
    try {
      const html = render(h(TurnCard, {
        appearance: 'chat', turnId: 'thinking-search', isComplete: true, isStreaming: false, searchQuery: 'needle',
        response: { messageId: 'answer', text: 'Finished', isStreaming: false },
        activities: [
          { id: 'read1', toolName: 'Read', type: 'tool', status: 'completed', timestamp: 1 },
          { id: 'reasoning', type: 'thinking', content: 'needle reasoning fixture', status: 'completed', timestamp: 2 },
          { id: 'read2', toolName: 'Read', type: 'tool', status: 'completed', timestamp: 3 },
        ],
      }))
      expect(html).toContain('data-inline-tool="summary:read1"')
      expect(html).toContain('needle reasoning fixture')
      expect(writes).toEqual([])
    } finally {
      if (savedStorage) Object.defineProperty(globalThis, 'localStorage', savedStorage)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })

  it('reveals a matching child plan through both its work summary and subagent', () => {
    const html = render(h(TurnCard, {
      appearance: 'chat', turnId: 'plan-search', isComplete: true, isStreaming: false, searchQuery: 'needle',
      response: { messageId: 'answer', text: 'Finished', isStreaming: false },
      activities: [
        { id: 'agent', toolName: 'Agent', toolUseId: 'agent1', type: 'tool', status: 'completed', timestamp: 1 },
        { id: 'child-plan', messageId: 'child-plan', parentId: 'agent1', type: 'plan', content: '# needle child proposal', status: 'completed', timestamp: 2 },
        { id: 'read1', toolName: 'Read', type: 'tool', status: 'completed', timestamp: 3 },
        { id: 'read2', toolName: 'Read', type: 'tool', status: 'completed', timestamp: 4 },
      ],
    }))
    expect(html).toContain('data-inline-tool="summary:agent"')
    expect(html).toContain('data-inline-tool="agent:agent"')
    expect(html).toContain('needle child proposal')
  })

  it('retains source disclosures inside an expanded completed-work summary', () => {
    const html = render(h(TurnCard, {
      appearance: 'chat', turnId: 'source-summary', isComplete: true, isStreaming: false, defaultExpanded: true,
      response: { messageId: 'answer', text: 'Finished', isStreaming: false },
      activities: [1, 2, 3].map(index => ({
        id: `linear${index}`, sourceMessageId: `sdk${index}`, toolName: 'mcp__linear__read',
        type: 'tool' as const, status: 'completed' as const, timestamp: index,
      })),
    }))
    expect(html).toContain('data-inline-tool="summary:sdk1"')
    expect(html).toContain('data-inline-tool="mcp:sdk1"')
  })
})
