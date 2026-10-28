import { expect, test } from 'bun:test'
import { reviewerUsage } from './usage'
const record = (events: unknown[], status: 'completed' | 'failed' = 'completed') => reviewerUsage({ role: 'bugs', requestedModel: 'gpt-6-astra', effort: 'high', round: 1, startedAt: 100, finishedAt: 350, status, events: events.map(event => JSON.stringify(event)).join('\n') })
test('CLI token counters are actual measurements, without guessed account or served model', () => {
  const value = record([{ type: 'turn.completed', usage: { input_tokens: 30, cached_input_tokens: 20, output_tokens: 5 } }, { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } }])
  expect(value).toMatchObject({ inputTokens: 40, cacheReadTokens: 20, outputTokens: 7, durationMs: 250, servedModel: null, account: null, accountAttribution: 'unknown' })
})
test('reported upstream model and usage stay separate from request model without double counting', () => {
  const value = record([{ type: 'response.completed', response: { model: 'gpt-6-astra-actual', usage: { input_tokens: 99, output_tokens: 99 } } }, { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } }])
  expect(value).toMatchObject({ requestedModel: 'gpt-6-astra', servedModel: 'gpt-6-astra-actual', inputTokens: 10, cacheReadTokens: 2, outputTokens: 3 })
})
test('failure without usage stays unknown rather than zero and never copies text or credentials', () => {
  const value = record([{ type: 'error', message: 'secret credential and prompt' }], 'failed')
  expect(value).toMatchObject({ status: 'failed', inputTokens: null, outputTokens: null, cacheReadTokens: null, servedModel: null })
  expect(JSON.stringify(value)).not.toContain('secret')
  expect(JSON.stringify(value)).not.toContain('prompt')
})
test('malformed counters and conflicting served models are not presented as certain', () => {
  const value = record([{ type: 'turn.completed', usage: { input_tokens: -1, cached_input_tokens: '5', output_tokens: 2 } }, { type: 'response.completed', response: { model: 'one' } }, { type: 'response.completed', response: { model: 'two' } }])
  expect(value.inputTokens).toBeNull(); expect(value.cacheReadTokens).toBeNull(); expect(value.servedModel).toBeNull()
})
