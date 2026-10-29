import { expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('react-pdf', () => ({ Document: () => null, Page: () => null, pdfjs: { GlobalWorkerOptions: {} } }))
const { UserQuestionRequest } = await import('../structured/UserQuestionRequest')

it('renders real options, a written answer, pager and explicit submit/cancel without auto-answering', () => {
  let answers = 0
  const html = renderToStaticMarkup(React.createElement(UserQuestionRequest, {
    request: { requestId: 'q', sessionId: 's', createdAt: 1, questions: [
      { header: 'Target', question: 'Which project?', options: [{ label: 'Current', description: 'Keep the current project' }, { label: 'Another' }] },
      { question: 'Which checks?', multiSelect: true, options: [{ label: 'Types' }, { label: 'Tests' }] },
    ] },
    onResponse: () => { answers++ },
  }))
  expect(html).toContain('Which project?')
  expect(html.match(/role="radio"/g)).toHaveLength(2)
  expect(html).toContain('aria-label="Cancel agent"')
  expect(html).toContain('aria-label="Other response"')
  expect(html).toContain('size-7')
  expect(html).toContain('rounded-2xl')
  expect(html).toContain('rows="1"')
  expect(html).toContain('Question 2')
  expect(html).toContain('disabled=""')
  expect(answers).toBe(0)
})
