import { describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('react-pdf', () => ({ Document: () => null, Page: () => null, pdfjs: { GlobalWorkerOptions: {} } }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const { SendButton } = await import('../SendButton')
function render(isProcessing: boolean, disabled: boolean, appearance: 'chat' | 'default' = 'chat') {
  return renderToStaticMarkup(React.createElement(SendButton, { isProcessing, disabled, appearance, onStop: () => {} }))
}

describe('running chat controls', () => {
  it('offers a non-submitting Stop and a submitting Send when a running chat has a draft', () => {
    const html = render(true, false)
    expect(html.match(/<button/g)).toHaveLength(2)
    expect(html).toMatch(/type="button"[^>]*aria-label="chat.stopResponse"/)
    expect(html).toMatch(/type="submit"[^>]*aria-label="shortcuts.sendMessage"/)
    expect(html).not.toContain('disabled=""')
  })
  it('keeps Stop alone when sending is gated or the draft is empty', () => {
    const html = render(true, true)
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).toContain('data-state="stop"')
    expect(html).not.toContain('type="submit"')
  })
  it('keeps the idle send button disabled for an empty draft', () => {
    const html = render(false, true)
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).toContain('type="submit"')
    expect(html).toContain('disabled=""')
  })
  it('preserves the embedded editor control while processing', () => {
    const html = render(true, false, 'default')
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).not.toContain('type="submit"')
  })
})
