import { describe, expect, it } from 'bun:test'
import { highlightChatCode } from '../chat-code-highlight'

describe('Conductor chat syntax', () => {
  it('preserves TypeScript keyword, type and function scopes', () => {
    const html = highlightChatCode('export function greet(name: string) { return name }', 'typescript')!
    expect(html).toContain('class="hljs-keyword">export')
    expect(html).toContain('class="hljs-title function_">greet')
    expect(html).toContain('class="hljs-built_in">string')
  })

  it('distinguishes JSON keys, strings, booleans and numbers', () => {
    const html = highlightChatCode('{"name":"Craft","active":true,"count":2}', 'json')!
    expect(html).toContain('class="hljs-attr">&quot;name&quot;')
    expect(html).toContain('class="hljs-string">&quot;Craft&quot;')
    expect(html).toContain('class="hljs-literal"><span class="hljs-keyword">true')
    expect(html).toContain('class="hljs-number">2')
  })

  it('highlights shell syntax and escapes literal HTML in the output', () => {
    const html = highlightChatCode('# check\necho "<script>"', 'bash')!
    expect(html).toContain('class="hljs-comment"># check')
    expect(html).toContain('class="hljs-string">&quot;&lt;script&gt;&quot;')
    expect(html).not.toContain('<script>')
  })

  it('escapes plain text and leaves unknown or oversized blocks unhighlighted', () => {
    expect(highlightChatCode('<literal>', 'text')).toBe('&lt;literal&gt;')
    expect(highlightChatCode('<literal>', 'unknown-language')).toBeUndefined()
    expect(highlightChatCode('x'.repeat(100_001), 'typescript')).toBeUndefined()
  })
})
