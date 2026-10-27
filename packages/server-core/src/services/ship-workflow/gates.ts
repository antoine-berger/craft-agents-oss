import { createHash } from 'node:crypto'
import type { ShipGateName, ShipGateResult, ShipRole } from '../../../../shared/src/protocol/ship-workflow'
export const SHIP_BOUNDS = { g1: 2, build: 5, review: 3, e2e: 2, devin: 4 } as const
export interface ShipClaim { id: string; claim: string; kind: 'code' | 'doc' | 'prod' | 'ticket' | 'vendor-doc'; source: string }
export interface ShipContractLine { id: string; deferred: boolean }
export interface ShipVerdict {
  version: 1; role: ShipRole; head: string; planHash: string; summary: string
  claims?: Array<{ id: string; status: 'CONFIRMED' | 'REFUTED' | 'UNVERIFIABLE'; evidence: string }>
  findings?: Array<{ id: string; blocking: boolean; kind?: 'rule' | 'bug'; claim: string; evidence: string; fix: string }>
  lines?: Array<{ id: string; status: 'PROVEN' | 'DEFERRED' | 'NOT_PROVEN' | 'BLOCKED'; evidence: string }>
}
export function hashShipArtifacts(files: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest('hex')
}
export function parseShipClaims(input: string): ShipClaim[] {
  const seen = new Set<string>()
  return input.split('\n').filter(line => line.trim()).map(line => {
    const claim = JSON.parse(line) as ShipClaim
    if (!/^[A-Za-z][\w-]*$/.test(claim.id) || seen.has(claim.id) || !['code', 'doc', 'prod', 'ticket', 'vendor-doc'].includes(claim.kind) || !claim.claim?.trim() || !claim.source?.trim()) throw new Error('Invalid or duplicate claim')
    seen.add(claim.id); return claim
  })
}
export function parseShipContract(input: string): ShipContractLine[] {
  const lines = input.split('\n').flatMap(line => { const match = /^\s*(?:[-*]\s*)?(?:\*\*)?(C\d+)\b/.exec(line); return match ? [{ id: match[1]!, deferred: line.includes('(post-merge)') }] : [] })
  if (!lines.length || new Set(lines.map(line => line.id)).size !== lines.length) throw new Error('Contract requires unique C1, C2… acceptance lines')
  return lines
}
export function parseShipVerdict(text: string, expected: ShipRole): ShipVerdict {
  const clean = text.trim().replace(/^```(?:json)?\s*\n/, '').replace(/\n```$/, '')
  const result = JSON.parse(clean) as ShipVerdict
  if (result.version !== 1 || result.role !== expected || typeof result.head !== 'string' || typeof result.planHash !== 'string' || typeof result.summary !== 'string') throw new Error('Invalid reviewer verdict identity')
  for (const field of ['claims', 'findings', 'lines'] as const) if (result[field] !== undefined && !Array.isArray(result[field])) throw new Error('Invalid reviewer verdict collection')
  if (result.claims?.some(item => !item || typeof item.id !== 'string' || !['CONFIRMED', 'REFUTED', 'UNVERIFIABLE'].includes(item.status) || !item.evidence?.trim())) throw new Error('Invalid fact-check evidence')
  if (result.findings?.some(item => !item || typeof item.id !== 'string' || typeof item.blocking !== 'boolean' || !item.claim?.trim() || !item.evidence?.trim() || !item.fix?.trim())) throw new Error('Invalid finding evidence')
  if (result.lines?.some(item => !item || typeof item.id !== 'string' || !['PROVEN', 'DEFERRED', 'NOT_PROVEN', 'BLOCKED'].includes(item.status) || !item.evidence?.trim())) throw new Error('Invalid E2E evidence')
  return result
}
/** Deterministic gate: only attributed native child outputs enter this function. */
export function evaluateShipGate(input: { gate: ShipGateName; round: number; head: string; planHash: string; roles: ShipRole[]; verdicts: ShipVerdict[]; claims: ShipClaim[]; contract: ShipContractLine[]; now: string }): ShipGateResult {
  const reasons: string[] = []
  const toFix: NonNullable<ShipGateResult['toFix']> = []
  const verdicts = input.verdicts.filter(verdict => input.roles.includes(verdict.role))
  for (const role of input.roles) {
    const matches = verdicts.filter(verdict => verdict.role === role)
    if (!matches.length) reasons.push(`${role}: missing or invalid verdict`)
    for (const verdict of matches) if (verdict.head !== input.head || verdict.planHash !== input.planHash) reasons.push(`${role}: stale HEAD or plan`)
  }
  if (input.gate === 'g1') {
    for (const claim of input.claims) {
      const role = ['code', 'doc'].includes(claim.kind) ? 'factcheck-code' : 'factcheck-external'
      const judgments = verdicts.filter(verdict => verdict.role === role).flatMap(verdict => verdict.claims || []).filter(item => item.id === claim.id)
      if (!judgments.length || judgments.some(item => item.status !== 'CONFIRMED')) reasons.push(`${claim.id}: not confirmed by ${role}`)
    }
    if (!verdicts.some(verdict => verdict.role === 'omissions' && Array.isArray(verdict.findings))) reasons.push('Missing omissions report')
  }
  if (input.gate === 'review' && !verdicts.every(verdict => Array.isArray(verdict.findings))) reasons.push('Missing review findings array')
  for (const verdict of verdicts) for (const finding of verdict.findings || []) {
    // Comment style recommendations are retained, but do not invalidate a factual gate.
    if (verdict.role === 'comments' && finding.kind === 'rule') toFix.push({ role: verdict.role, ...finding })
    if ((input.gate === 'review' || finding.blocking) && !(verdict.role === 'comments' && finding.kind === 'rule')) reasons.push(`${verdict.role}/${finding.id}: ${finding.claim}`)
  }
  if (input.gate === 'e2e') {
    const lines = verdicts.flatMap(verdict => verdict.lines || [])
    for (const requirement of input.contract) {
      const proofs = lines.filter(line => line.id === requirement.id)
      if (!proofs.length || proofs.some(line => line.status !== 'PROVEN' && !(requirement.deferred && line.status === 'DEFERRED'))) reasons.push(`${requirement.id}: missing or unproven acceptance scenario`)
    }
    if (lines.some(line => !input.contract.some(requirement => requirement.id === line.id))) reasons.push('E2E verdict names an unknown acceptance line')
  }
  return { round: input.round, result: reasons.length ? 'fail' : 'pass', head: input.head, planHash: input.planHash, reasons, at: input.now, ...(toFix.length ? { toFix } : {}) }
}
