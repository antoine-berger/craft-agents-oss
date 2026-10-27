import { expect, test } from 'bun:test'
import { evaluateShipGate, hashShipArtifacts, parseShipClaims, parseShipContract, parseShipVerdict, type ShipVerdict } from './gates'
import { parseShipCommand } from '../../../../shared/src/protocol/ship-workflow'
const claims = [{ id: 'K1', claim: 'Current function throws', kind: 'code' as const, source: 'src/a.ts:12' }, { id: 'K2', claim: 'Ticket expects an error', kind: 'ticket' as const, source: 'ENG-1' }]
const head = 'a'.repeat(40), planHash = hashShipArtifacts({ 'plan.md': 'the actual plan' })
function verdict(role: ShipVerdict['role']): ShipVerdict { return { version: 1, role, head, planHash, summary: 'Observed evidence', claims: [], findings: [], lines: [] } }
const base = { gate: 'g1' as const, head, planHash, round: 1, roles: ['factcheck-code', 'factcheck-external', 'omissions'] as ShipVerdict['role'][], claims, contract: [{ id: 'C1', deferred: false }, { id: 'C2', deferred: true }], now: '2026-10-27T00:00:00Z' }
test('only exact slash commands are intercepted; a question or prose cannot start/approve a workflow', () => {
  expect(parseShipCommand('/ship')).toEqual({ kind: 'resume' })
  expect(parseShipCommand('/ship-plan eng-12')).toEqual({ kind: 'plan', ticket: 'ENG-12' })
  expect(parseShipCommand('/ship-plan https://linear.app/team/issue/ENG-12/title')).toEqual({ kind: 'plan', ticket: 'ENG-12' })
  for (const value of ['Can /ship do this?', 'go', 'I approve this plan', '/ship now', '/ship-plan ENG-1 and run', '/ship-plan https://linear.app.evil/team/issue/ENG-1/title', '/ship-plan https://user:secret@linear.app/team/issue/ENG-1/title']) expect(parseShipCommand(value)).toBeNull()
})
test('G1 requires every claim confirmed by its routed independent actor and an omissions report', () => {
  const code = { ...verdict('factcheck-code'), claims: [{ id: 'K1', status: 'CONFIRMED' as const, evidence: 'src/a.ts:12' }] }
  const external: ShipVerdict = { ...verdict('factcheck-external'), claims: [{ id: 'K2', status: 'CONFIRMED' as const, evidence: 'ticket verbatim acceptance line' }] }
  expect(evaluateShipGate({ ...base, verdicts: [code, external, verdict('omissions')] }).result).toBe('pass')
  expect(evaluateShipGate({ ...base, verdicts: [code, verdict('omissions')] }).result).toBe('fail')
  expect(evaluateShipGate({ ...base, verdicts: [code, external] }).reasons.join(' ')).toContain('omissions')
  external.claims![0]!.status = 'UNVERIFIABLE'
  expect(evaluateShipGate({ ...base, verdicts: [code, external, verdict('omissions')] }).result).toBe('fail')
})
test('stale HEAD and changed plan cannot pass even with optimistic model output', () => {
  const bug = verdict('bugs'); bug.head = 'b'.repeat(40)
  expect(evaluateShipGate({ ...base, gate: 'review', roles: ['bugs'], verdicts: [bug] }).result).toBe('fail')
  bug.head = head; bug.planHash = 'changed'
  expect(evaluateShipGate({ ...base, gate: 'review', roles: ['bugs'], verdicts: [bug] }).result).toBe('fail')
})
test('every review finding blocks except true comment-style rules; style fixes are retained', () => {
  const bug = verdict('bugs'); bug.findings = [{ id: 'F1', blocking: false, claim: 'This crashes', evidence: 'src/a.ts:12', fix: 'guard it' }]
  expect(evaluateShipGate({ ...base, gate: 'review', roles: ['bugs'], verdicts: [bug] }).result).toBe('fail')
  const comments = { ...verdict('comments'), findings: [{ ...bug.findings[0]!, kind: 'rule' as const }] }
  const result = evaluateShipGate({ ...base, gate: 'review', roles: ['comments'], verdicts: [comments] })
  expect(result.result).toBe('pass'); expect(result.toFix?.[0]?.id).toBe('F1')
})
test('E2E requires proof for every contract ID; deferred proof is allowed only post-merge', () => {
  const proof = verdict('e2e'); proof.lines = [{ id: 'C1', status: 'PROVEN', evidence: 'scoped test passed, expected HTTP 400 observed' }, { id: 'C2', status: 'DEFERRED', evidence: 'post-deploy metric window, explicitly not measured' }]
  expect(evaluateShipGate({ ...base, gate: 'e2e', roles: ['e2e'], verdicts: [proof] }).result).toBe('pass')
  proof.lines[0]!.status = 'DEFERRED'
  expect(evaluateShipGate({ ...base, gate: 'e2e', roles: ['e2e'], verdicts: [proof] }).result).toBe('fail')
  proof.lines = []
  expect(evaluateShipGate({ ...base, gate: 'e2e', roles: ['e2e'], verdicts: [proof] }).reasons).toHaveLength(2)
})
test('malformed outputs, duplicate contracts/claims and missing evidence fail closed', () => {
  expect(() => parseShipVerdict('VERDICT: PASS', 'bugs')).toThrow()
  expect(() => parseShipVerdict(JSON.stringify(verdict('omissions')), 'bugs')).toThrow()
  expect(() => parseShipVerdict(JSON.stringify({ ...verdict('bugs'), findings: [{ id: 'f', blocking: true }] }), 'bugs')).toThrow()
  expect(() => parseShipContract('C1 input -> output\nC1 duplicate')).toThrow()
  expect(() => parseShipContract('No acceptance IDs')).toThrow()
  expect(() => parseShipClaims([claims[0], claims[0]].map(claim => JSON.stringify(claim)).join('\n'))).toThrow()
  expect(hashShipArtifacts({ a: '1', b: '2' })).toBe(hashShipArtifacts({ b: '2', a: '1' }))
  expect(parseShipContract('- **C1** before/after\nC2 production metric (post-merge)')).toEqual([{ id: 'C1', deferred: false }, { id: 'C2', deferred: true }])
})
