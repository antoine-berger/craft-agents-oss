import { expect, it } from 'bun:test'
import { getInlineToolData } from '../turn/inline-tool-data'

const input = { questions: [{ question: 'Which target?', options: [{ label: 'Preview' }, { label: 'Production' }] }] }
it('shows captured questions and actual answered/cancelled/pending status without raw JSON', () => {
  const base = { id: 'q', type: 'tool' as const, toolName: 'mcp__session__AskUserQuestion', timestamp: 1, toolInput: input }
  expect(getInlineToolData({ ...base, status: 'running' })).toMatchObject({ kind: 'question', preview: 'Awaiting response', questions: input.questions })
  expect(getInlineToolData({ ...base, status: 'completed', content: 'User responses:\n1. Preview' })).toMatchObject({ kind: 'question', preview: 'Answered' })
  expect(getInlineToolData({ ...base, status: 'completed', content: 'User cancelled the questions.' })).toMatchObject({ preview: 'Cancelled' })
  expect(getInlineToolData({ ...base, status: 'error', content: '[ERROR] Chat stopped' })).toMatchObject({ preview: 'Failed' })
})
