import { expect, it } from 'bun:test'
import { handleMarkAttention, handleRequestUserInput, RequestUserInputSchema, type AttentionToolContext } from './attention'
it('requires an explicit structured blocking request, persists the question/choices, and instructs the agent to stop', async () => {
  const requests: unknown[] = []
  const ctx = { markAttention: (request: unknown) => { requests.push(request) } } as AttentionToolContext
  const result = await handleRequestUserInput(ctx, { question: 'Which environment?', choices: ['Preview', 'Production'] })
  expect(requests).toEqual([{ kind: 'question', title: 'Which environment?', detail: 'Which environment?\n1. Preview\n2. Production' }])
  expect(JSON.stringify(result)).toContain('End this turn')
  expect(RequestUserInputSchema.safeParse({ question: ' ' }).success).toBe(false)
  expect(JSON.stringify(await handleMarkAttention({} as AttentionToolContext, { kind: 'error', title: 'Missing access' }))).toContain('unavailable')
})
