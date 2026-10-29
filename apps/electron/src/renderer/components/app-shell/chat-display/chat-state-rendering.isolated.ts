import { describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { setupI18n } from '@craft-agent/shared/i18n'
import { initReactI18next } from 'react-i18next'
import type { Message } from '../../../../shared/types'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('react-pdf', () => ({ Document: () => null, Page: () => null, pdfjs: { GlobalWorkerOptions: {} } }))
const { ErrorMessage } = await import('./ErrorMessage')
const { equalMessageBubbleProps } = await import('./MessageBubble')
const { PermissionRequest } = await import('../input/structured/PermissionRequest')
setupI18n([initReactI18next])
const h = React.createElement
const render = (element: React.ReactElement) => renderToStaticMarkup(element)
const message: Message = { id: 'error', role: 'error', content: 'Too many requests. Wait a moment.', timestamp: 1, errorCode: 'rate_limited', errorTitle: 'Rate limit reached', errorActions: [{ key: 'retry', label: 'Retry', action: 'retry' }] }

describe('compact chat states', () => {
  it('retains real recovery actions without guessing reset information', () => {
    const html = render(h(ErrorMessage, { message, appearance: 'chat', onRetry: () => {} }))
    expect(html).toContain('data-chat-message-state="limit"')
    expect(html).toContain('Rate limit reached')
    expect(html).toContain('Retry')
    expect(html).not.toContain('reset')
    expect(html).not.toContain('px-3.5 py-3')
  })
  it('shows owner interruptions as notices and does not offer to replay them', () => {
    const html = render(h(ErrorMessage, { message: { ...message, content: 'Response interrupted.' }, appearance: 'chat' }))
    expect(html).toContain('data-chat-message-state="interrupted"')
    expect(html).toContain('role="status"')
    expect(html).not.toContain('Retry')
  })
  it('does not show an ineffective resend for an exhausted context', () => {
    const html = render(h(ErrorMessage, { message: { ...message, errorCode: undefined, content: 'Input exceeded the context window' }, appearance: 'chat' }))
    expect(html).toContain('data-chat-message-state="context"')
    expect(html).not.toContain('Retry')
  })
  it('keeps a one-time permission and remember policy distinct', () => {
    const html = render(h(PermissionRequest, { appearance: 'chat', request: { requestId: 'p', sessionId: 's', toolName: 'Bash', description: 'Run test', command: 'bun test', canRemember: false }, onResponse: () => {} }))
    expect(html).toContain('bun test')
    expect(html).toContain('permission-banner')
    expect(html).not.toContain('Always Allow')
    expect(html).toContain('Allow')
    expect(html).toContain('Deny')
  })
  it('keeps a long pending Bash command readable after expanding the permission preview', () => {
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => 'true', setItem: () => {} } })
    try {
      const command = `echo ${'long-argument-'.repeat(60)} PERMISSION_COMMAND_END`
      const html = render(h(PermissionRequest, { appearance: 'chat', request: { requestId: 'long-command', sessionId: 's', toolName: 'Bash', description: 'Run command', command, canRemember: false }, onResponse: () => {} }))
      const code = html.match(/<code[^>]*>([\s\S]*?)<\/code>/)?.[1]?.replace(/<[^>]*>/g, '')
      expect(html).toContain('aria-expanded="true"')
      expect(code).toBe(command)
      expect(html).not.toContain('Always Allow')
    } finally {
      if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })
})

describe('message state memoization', () => {
  const props = { message: { ...message, role: 'user' as const }, onOpenFile: () => {}, onOpenUrl: () => {}, appearance: 'chat' as const }
  it('does not suppress queued, attachment or error-state transitions with unchanged content', () => {
    expect(equalMessageBubbleProps(props, props)).toBe(true)
    for (const update of [{ isQueued: true }, { isPending: true }, { attachments: [] }, { errorActions: [] }]) {
      expect(equalMessageBubbleProps(props, { ...props, message: { ...props.message, ...update } })).toBe(false)
    }
    expect(equalMessageBubbleProps(props, { ...props, onRetry: () => {} })).toBe(false)
  })
})
