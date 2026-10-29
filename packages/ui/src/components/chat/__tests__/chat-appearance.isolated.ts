import { describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlainMessageText } from '../PlainMessageText'

// Vite's worker URL import has no Node/Bun default export. No PDF is rendered here.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('react-pdf', () => ({ Document: () => null, Page: () => null, pdfjs: { GlobalWorkerOptions: {} } }))
const { UserMessageBubble } = await import('../UserMessageBubble')
const { Markdown } = await import('../../markdown/Markdown')
const { CodeBlock } = await import('../../markdown/CodeBlock')
const h = React.createElement
const render = (element: React.ReactElement) => renderToStaticMarkup(element)

describe('literal chat prompts', () => {
  it('preserves Markdown-looking input and escapes HTML rather than interpreting it', () => {
    const html = render(h(PlainMessageText, {
      children: '# Heading\n**literal**\n```js\n<script>alert(1)</script>\n```',
    }))
    expect(html).toContain('# Heading\n**literal**\n```js')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toMatch(/<(h1|strong|pre|script)[ >]/)
  })

  it('links plain URLs and email addresses without swallowing punctuation', () => {
    const html = render(h(PlainMessageText, {
      children: 'See https://example.org/a?q=1, or hello@example.org.',
    }))
    expect(html).toContain('href="https://example.org/a?q=1"')
    expect(html).toContain('</a>, or ')
    expect(html).toContain('href="mailto:hello@example.org"')
    expect(html).toContain('</a>.')
  })

  it('keeps file navigation callback-only and unsafe schemes out of DOM hrefs', () => {
    const html = render(h(PlainMessageText, { children: 'Open ./src/app.ts and javascript:alert(1)' }))
    expect(html).toContain('>./src/app.ts</a>')
    expect(html).not.toContain('href="./src/app.ts"')
    expect(html).not.toContain('href="javascript:')
  })

  it('keeps hidden edit metadata from shifting later badge positions', () => {
    const prefix = '<edit_request>hidden</edit_request>'
    const content = `${prefix}# literal\n  @ship  **text**`
    const start = content.indexOf('@ship')
    const html = render(h(UserMessageBubble, { appearance: 'chat', content, compactMode: true, badges: [
      { type: 'context', start: 0, end: prefix.length, rawText: prefix, label: 'Edit' },
      { type: 'skill', start, end: start + 5, label: 'ship' },
    ] }))
    expect(html).not.toContain('hidden')
    expect(html).not.toContain('edit_request')
    expect(html).toContain('# literal\n  ')
    expect(html).toContain('ship')
    expect(html).toContain('  **text**')
    expect(html).not.toContain('<strong>')
  })

  it('retains Markdown for embedded messages outside the opted-in transcript', () => {
    const html = render(h(UserMessageBubble, { content: '**formatted**', compactMode: true }))
    expect(html).toContain('<strong')
    expect(html).not.toContain('**formatted**')
  })
})

describe('chat Markdown appearance', () => {
  it('renders JSON and diff fences as copyable code instead of rich document widgets', () => {
    const html = render(h(Markdown, { mode: 'chat',
      children: '```json\n{"enabled":true}\n```\n\n```diff\n-old\n+new\n```',
    }))
    expect(html.match(/data-code-appearance="chat"/g)).toHaveLength(2)
    expect(html).toContain('&quot;enabled&quot;:true')
    expect(html).toContain('-old\n+new')
    expect(html).not.toContain('w-json-view')
  })

  it('preserves headings, tables and safe file/link targets in chat mode', () => {
    const html = render(h(Markdown, { mode: 'chat',
      children: '# Heading\n\n| Key | Value |\n| --- | --- |\n| A | B |\n\n[local](file:///tmp/a.ts) and [unsafe](javascript:alert%281%29)',
    }))
    expect(html).toContain('<h1')
    expect(html).toContain('<table')
    expect(html).toContain('>local</a>')
    expect(html).not.toContain('href="file:')
    expect(html).not.toContain('href="javascript:')
  })

  it('changes code chrome only when explicitly requested', () => {
    const regular = render(h(CodeBlock, { code: 'const a = 1', language: 'ts' }))
    const chat = render(h(CodeBlock, { code: 'const a = 1', language: 'ts', appearance: 'chat' }))
    expect(regular).toContain('>typescript</span>')
    expect(chat).not.toContain('>typescript</span>')
    expect(chat).toContain('const a = 1')
    expect(chat).toContain('data-code-appearance="chat"')
    expect(regular).not.toContain('data-code-appearance')
    expect(chat).toContain('<button')
  })
})
