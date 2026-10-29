import { afterEach, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('react-pdf', () => ({ Document: () => null, Page: () => null, pdfjs: { GlobalWorkerOptions: {} } }))
const { UserQuestionRequest } = await import('../structured/UserQuestionRequest')
import type { UserQuestionResponse } from '@craft-agent/core/types'

const request = { requestId: 'q', sessionId: 's', createdAt: 1, questions: [
  { question: '**Which project?**', options: [{ label: 'Current' }, { label: 'Another' }] },
  { question: 'Which checks?', multiSelect: true, options: [{ label: 'Types' }, { label: 'Tests' }] },
] }
const originalWindow = globalThis.window
let tree: TestRenderer.ReactTestRenderer
let keys = new Set<(event: KeyboardEvent) => void>()
let focusOther = 0
const field = { focus: () => {}, contains: (target: unknown) => target === textarea }
const textarea = { matches: () => true, focus: () => { focusOther++ } }
afterEach(async () => {
  await act(async () => { tree?.unmount() })
  globalThis.window = originalWindow
  keys.clear(); focusOther = 0
})
async function harness(sendKey = 'enter', interactive = true) {
  const responses: UserQuestionResponse[] = []
  globalThis.window = { electronAPI: { getSendMessageKey: async () => sendKey },
    addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => { if (type === 'keydown') keys.add(listener) },
    removeEventListener: (type: string, listener: (event: KeyboardEvent) => void) => { if (type === 'keydown') keys.delete(listener) },
  } as unknown as Window & typeof globalThis
  await act(async () => { tree = TestRenderer.create(React.createElement(UserQuestionRequest, {
    request, interactive, onResponse: value => responses.push(value.response),
  }), { createNodeMock: element => element.type === 'fieldset' ? field : element.type === 'textarea' ? textarea : null }) })
  return responses
}
async function key(key: string, extra: Record<string, unknown> = {}) {
  const event = { key, defaultPrevented: false, preventDefault() { Object.assign(event, { defaultPrevented: true }) }, stopPropagation() {}, target: field, ...extra } as unknown as KeyboardEvent
  await act(async () => { for (const callback of [...keys]) callback(event) })
  return event
}
describe('question keyboard and compact controls', () => {
  it('offers free pager navigation, numbered choices, multiselect and Enter submission', async () => {
    const responses = await harness()
    await key('ArrowRight')
    expect(tree.root.findAllByProps({ role: 'checkbox' })).toHaveLength(2)
    await key('ArrowLeft')
    await key('1') // A single choice advances, without submitting.
    expect(responses).toHaveLength(0)
    await key('1'); await key('2'); await key('Enter')
    expect(responses).toEqual([{ answers: [{ selected: ['Current'] }, { selected: ['Types', 'Tests'] }] }])
  })
  it('supports Other, configured Cmd+Enter, text input and IME protection', async () => {
    const responses = await harness('cmd-enter')
    await key('0')
    expect(focusOther).toBe(1)
    await act(async () => { tree.root.findByType('textarea').props.onChange({ target: { value: 'Written choice' } }) })
    await key('2', { target: textarea })
    await key('ArrowRight', { target: textarea })
    expect(tree.root.findByType('textarea').props.value).toBe('Written choice')
    await key('Enter', { target: textarea }) // Plain Enter remains editable.
    expect(tree.root.findAllByProps({ role: 'radio' })).toHaveLength(2)
    await key('Enter', { target: textarea, metaKey: true, isComposing: true })
    expect(tree.root.findAllByProps({ role: 'radio' })).toHaveLength(2)
    await key('Enter', { target: textarea, metaKey: true })
    await key('1'); await key('Enter', { ctrlKey: true })
    expect(responses).toEqual([{ answers: [{ selected: [], text: 'Written choice' }, { selected: ['Types'] }] }])
  })
  it('does not steal another pane input or register shortcuts on a measuring/inactive copy', async () => {
    const responses = await harness()
    await key('1', { target: { matches: () => true } })
    await key('Escape', { target: { matches: () => true } })
    expect(responses).toHaveLength(0)
    expect(tree.root.findAllByProps({ role: 'radio' })).toHaveLength(2)
    await act(async () => { tree.update(React.createElement(UserQuestionRequest, { request, interactive: false, onResponse: value => responses.push(value.response) })) })
    expect(keys.size).toBe(0)
    await key('Escape')
    expect(responses).toHaveLength(0)
  })
  it('Escape and X explicitly cancel the owner question', async () => {
    const responses = await harness()
    await key('Escape')
    await act(async () => { tree.root.findByProps({ 'aria-label': 'Cancel agent' }).props.onClick() })
    expect(responses).toEqual([{ cancelled: true, answers: [] }, { cancelled: true, answers: [] }])
  })
})
