import { expect, it } from 'bun:test'
import type { ActivityItem } from '../TurnCard'
import { collectResponseFiles } from '../turn/response-files'

it('attributes only completed writes in this response, deduplicating paths without inventing Git counts', () => {
  const activity = (id: string, toolName: string, toolInput: Record<string, unknown>, status = 'completed'): ActivityItem => ({ id, type: 'tool', status: status as any, timestamp: 1, toolName, toolInput })
  expect(collectResponseFiles([
    activity('read', 'Read', { file_path: 'read-only.ts' }),
    activity('write', 'Write', { file_path: 'changed.ts', content: 'hello' }),
    activity('edit', 'Edit', { file_path: 'changed.ts', old_string: 'hello', new_string: 'world' }),
    activity('failed', 'Write', { file_path: 'failed.ts', content: 'x' }, 'error'),
    activity('running', 'Write', { file_path: 'running.ts', content: 'x' }, 'running'),
  ])).toEqual(['changed.ts'])
})
