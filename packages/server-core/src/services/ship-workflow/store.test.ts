import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readShipArtifacts, shipDirectory, SHIP_ARTIFACTS } from './store'

test('only bounded regular plan files can contribute to a gate/approval hash', () => {
  const root = mkdtempSync(join(tmpdir(), 'craft-ship-artifact-test-'))
  try {
    const dir = join(shipDirectory(root, 'ship-fixture'), 'plan'); mkdirSync(dir, { recursive: true })
    for (const name of SHIP_ARTIFACTS) writeFileSync(join(dir, name), name === 'claims.jsonl' ? '' : 'fixture')
    expect(Object.keys(readShipArtifacts(root, 'ship-fixture'))).toHaveLength(6)
    rmSync(join(dir, 'plan.md')); writeFileSync(join(root, 'external.md'), 'outside')
    symlinkSync(join(root, 'external.md'), join(dir, 'plan.md'))
    expect(() => readShipArtifacts(root, 'ship-fixture')).toThrow('artifact')
    rmSync(join(dir, 'plan.md')); writeFileSync(join(dir, 'plan.md'), 'x'.repeat(4 * 1024 * 1024 + 1))
    expect(() => readShipArtifacts(root, 'ship-fixture')).toThrow('4 MiB')
    expect(() => shipDirectory(root, '../../foreign')).toThrow('Invalid')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('human preview reads only the three native artifacts with their actual complete plan hash', async () => {
  const { readShipPlanPreview, readShipState, writeShipState } = await import('./store')
  const { hashShipArtifacts } = await import('./gates')
  const root = mkdtempSync(join(tmpdir(), 'craft-ship-preview-test-'))
  try {
    const id = 'ship-preview', dir = join(shipDirectory(root, id), 'plan'); mkdirSync(dir, { recursive: true })
    for (const name of SHIP_ARTIFACTS) writeFileSync(join(dir, name), name === 'claims.jsonl' ? '' : `${name}: complete proposal, café and <script> remain plain text.`)
    const state = { version: 1, id, taskSlug: id, phase: 'discussion' } as import('../../../../shared/src/protocol/ship-workflow').ShipWorkflowState
    writeShipState(root, state, 'fixture')
    const before = JSON.stringify(readShipState(root, id))
    const preview = readShipPlanPreview(root, state)
    expect(preview.files.map(file => file.name)).toEqual(['plan.md', 'brief.md', 'contract.md'])
    expect(preview.planHash).toBe(hashShipArtifacts(readShipArtifacts(root, id)))
    expect(Buffer.from(preview.files[0]!.contentBase64, 'base64').toString('utf8')).toContain('café')
    expect(preview.totalBytes).toBe(preview.files.reduce((size, file) => size + file.size, 0))
    expect(JSON.stringify(readShipState(root, id))).toBe(before)
    expect(state.planPreview).toBeUndefined()
    expect(() => readShipPlanPreview(root, { ...state, phase: 'g1' })).toThrow('not ready')
    expect(() => readShipPlanPreview(root, { ...state, id: '../../foreign' })).toThrow('Invalid')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
