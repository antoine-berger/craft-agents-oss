import { expect, test } from 'bun:test'
import type { ShipWorkflowAPI, ShipWorkflowState } from '../../../../../packages/shared/src/protocol/ship-workflow'
import { newerShipWorkflowState, observeShipWorkflow } from './ship-workflow-state'
const state = (revision: number): ShipWorkflowState => ({ id: 'ship-fixture', sessionId: 'session', orchestratorSessionId: 'parent', revision, createdAt: '2026-10-27T00:00:00Z' } as ShipWorkflowState)
function fixture() {
  let listener: ((workspace: string, state: ShipWorkflowState) => void) | undefined
  let resolve!: (state: ShipWorkflowState | null) => void, reject!: (error: Error) => void, unsubscribed = false
  const seen: Array<ShipWorkflowState | null> = []; let errors = 0
  const api: Pick<ShipWorkflowAPI, 'getShipWorkflow' | 'onShipWorkflowChanged'> = { getShipWorkflow: () => new Promise<ShipWorkflowState | null>((yes, no) => { resolve = yes; reject = no }), onShipWorkflowChanged: (callback: typeof listener) => { listener = callback; return () => { unsubscribed = true } } }
  const stop = observeShipWorkflow(api, 'workspace', 'session', next => seen.push(next), () => { errors++ })
  return { seen, stop, emit: (next: ShipWorkflowState, workspace = 'workspace') => listener?.(workspace, next), resolve: (next: ShipWorkflowState | null) => resolve(next), reject: () => reject(new Error('disconnected')), errors: () => errors, unsubscribed: () => unsubscribed }
}
test('late empty initial snapshot cannot hide a workflow started by the exact slash command', async () => {
  const f = fixture(); f.emit(state(3)); f.resolve(null); await Promise.resolve(); await Promise.resolve()
  expect(f.seen.at(-1)?.revision).toBe(3); f.stop()
})
test('older RPC snapshots/events and another workspace cannot overwrite the latest revision', async () => {
  const f = fixture(); f.emit(state(10)); f.emit(state(9)); f.emit(state(99), 'another-workspace'); f.resolve(state(8)); await Promise.resolve()
  expect(f.seen.at(-1)?.revision).toBe(10); f.stop(); expect(f.unsubscribed()).toBe(true)
  f.emit(state(11)); expect(f.seen.at(-1)?.revision).toBe(10)
})
test('unmount and late request failures cannot mutate a different session or replace live state', async () => {
  const f = fixture(); f.emit(state(4)); f.reject(); await Promise.resolve(); await Promise.resolve()
  expect(f.errors()).toBe(0); expect(f.seen.at(-1)?.revision).toBe(4); f.stop()
  const other = fixture(); other.stop(); other.resolve(state(5)); await Promise.resolve(); expect(other.seen.at(-1)).toBeNull()
})

test('a delayed action result cannot roll the panel back behind a newer server push', () => {
  const pushed = state(12), staleRPC = state(10)
  expect(newerShipWorkflowState(pushed, staleRPC)).toBe(pushed)
  expect(newerShipWorkflowState(pushed, state(13))?.revision).toBe(13)
  expect(newerShipWorkflowState(pushed, null)).toBe(pushed)
})

test('complete plan decoding preserves UTF-8/plain text and rejects incomplete or oversized artifacts', async () => {
  const { decodeShipPlanPreview } = await import('./ship-workflow-state')
  const names = ['plan.md', 'brief.md', 'contract.md'] as const
  const files = names.map(name => { const bytes = Buffer.from(`${name}: café, <script>plain text</script>`); return { name, contentBase64: bytes.toString('base64'), size: bytes.length } })
  const preview = { planHash: 'fixture-hash', files, totalBytes: files.reduce((total, file) => total + file.size, 0) }
  expect(decodeShipPlanPreview(preview)['plan.md']).toContain('café, <script>plain text</script>')
  expect(() => decodeShipPlanPreview({ ...preview, files: files.slice(0, 2) })).toThrow('Invalid')
  expect(() => decodeShipPlanPreview({ ...preview, totalBytes: 4 * 1024 * 1024 + 1 })).toThrow('oversized')
  expect(() => decodeShipPlanPreview({ ...preview, files: [{ ...files[0]!, size: 1 }, ...files.slice(1)] })).toThrow('size mismatch')
  expect(() => decodeShipPlanPreview({ ...preview, totalBytes: preview.totalBytes + 1 })).toThrow('total mismatch')
})
