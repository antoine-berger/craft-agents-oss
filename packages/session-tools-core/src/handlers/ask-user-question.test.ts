import { describe, expect, it } from 'bun:test'
import { AskUserQuestionSchema, handleAskUserQuestion } from './ask-user-question'
import type { SessionToolContext } from '../context'

const questions = [{ question: 'Which target?', options: [{ label: 'Preview' }, { label: 'Production' }] }]
describe('AskUserQuestion MCP handler', () => {
  it('waits for an actual response and records the selected and written answers', async () => {
    let answer!: (response: { answers: Array<{ selected: string[]; text?: string }> }) => void
    const ctx = { askUserQuestion: () => new Promise(resolve => { answer = resolve }) } as unknown as SessionToolContext
    const result = handleAskUserQuestion(ctx, { questions })
    let done = false
    void result.then(() => { done = true })
    await Promise.resolve()
    expect(done).toBe(false)
    answer({ answers: [{ selected: ['Preview'], text: 'Use the existing project' }] })
    expect((await result).content).toEqual([{ type: 'text', text: 'User responses:\n1. Preview; Use the existing project' }])
  })
  it('makes cancellation explicit and never fabricates approval', async () => {
    const ctx = { askUserQuestion: async () => ({ cancelled: true, answers: [] }) } as unknown as SessionToolContext
    const cancelled = await handleAskUserQuestion(ctx, { questions })
    expect(cancelled).toMatchObject({ isError: true })
    expect(JSON.stringify(cancelled)).toContain('No answer or approval was granted')
    const failed = { askUserQuestion: async () => { throw new Error('Chat stopped') } } as unknown as SessionToolContext
    expect(await handleAskUserQuestion(failed, { questions })).toMatchObject({ isError: true })
    expect(JSON.stringify(await handleAskUserQuestion({} as SessionToolContext, { questions }))).toContain('unavailable')
  })
  it('rejects oversized or ambiguous questions before requesting owner input', () => {
    expect(AskUserQuestionSchema.safeParse({ questions: [] }).success).toBe(false)
    expect(AskUserQuestionSchema.safeParse({ questions: [{ ...questions[0], options: [{ label: 'Same' }, { label: 'Same' }] }] }).success).toBe(false)
    expect(AskUserQuestionSchema.safeParse({ questions: Array(5).fill(questions[0]) }).success).toBe(false)
  })
})
