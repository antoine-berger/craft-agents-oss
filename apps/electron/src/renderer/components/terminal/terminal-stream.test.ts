import { expect, test } from 'bun:test'
import { TerminalStream } from './terminal-stream'
import type { SessionTerminalSnapshot } from '@craft-agent/shared/protocol'
const initial: SessionTerminalSnapshot = { id: 'terminal', sessionId: 'chat', sequence: 2, status: 'running', output: 'old output', truncated: false }
test('reconnect snapshot suppresses replayed chunks and identifies a gap needing a new snapshot', () => {
  const writes: Array<[string, boolean]> = []
  const stream = new TerminalStream((data, reset) => writes.push([data, reset]))
  stream.snapshot(initial)
  expect(stream.event({ type: 'output', id: 'terminal', sessionId: 'chat', sequence: 2, data: 'duplicate' })).toBe('ignored')
  expect(stream.event({ type: 'output', id: 'terminal', sessionId: 'chat', sequence: 3, data: 'new output' })).toBe('applied')
  expect(stream.event({ type: 'output', id: 'terminal', sessionId: 'chat', sequence: 5, data: 'missing sequence' })).toBe('gap')
  expect(stream.event({ type: 'snapshot', snapshot: { ...initial, sequence: 1, output: 'stale', status: 'exited' } })).toBe('ignored')
  expect(stream.event({ type: 'snapshot', snapshot: { ...initial, id: 'another', sequence: 9 } })).toBe('ignored')
  expect(writes).toEqual([['old output', true], ['new output', false]])
  stream.snapshot({ ...initial, sequence: 5, output: 'complete replay' })
  expect(writes.at(-1)).toEqual(['complete replay', true])
})
