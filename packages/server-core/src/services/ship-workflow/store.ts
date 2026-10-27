import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync, writeFileSync, appendFileSync, lstatSync, realpathSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ShipPlanPreview, ShipWorkflowState } from '../../../../shared/src/protocol/ship-workflow'
import { hashShipArtifacts } from './gates'
export const SHIP_ARTIFACTS = ['ticket.md', 'plan.md', 'brief.md', 'contract.md', 'baseline.md', 'claims.jsonl'] as const
export function shipDirectory(root: string, slug: string): string {
  if (!/^ship-[a-z0-9-]+$/.test(slug)) throw new Error('Invalid Ship workflow ID')
  return join(root, 'tasks', slug, 'ship')
}
function ownedDirectory(root: string, slug: string, create = false): string {
  shipDirectory(root, slug) // validates the identifier before touching the filesystem
  let dir = realpathSync(root)
  for (const part of ['tasks', slug, 'ship']) {
    dir = join(dir, part)
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error('Ship storage directories cannot be symbolic links')
    if (create && !existsSync(dir)) mkdirSync(dir, { mode: 0o700 })
  }
  return dir
}
export function readShipState(root: string, slug: string): ShipWorkflowState | null {
  const file = join(ownedDirectory(root, slug), 'state.json')
  if (!existsSync(file)) return null
  if (lstatSync(file).isSymbolicLink() || lstatSync(file).size > 1024 * 1024) throw new Error('Invalid Ship state file')
  const value = JSON.parse(readFileSync(file, 'utf8')) as ShipWorkflowState
  if (value.version !== 1 || value.id !== slug || value.taskSlug !== slug) throw new Error('Unsupported Ship workflow state')
  return value
}
export function writeShipState(root: string, state: ShipWorkflowState, event: string): void {
  const dir = ownedDirectory(root, state.id, true)
  const file = join(dir, 'state.json'); const temporary = join(dir, `state-${randomUUID()}.tmp`)
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 }); renameSync(temporary, file)
  appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ at: state.updatedAt, revision: state.revision, phase: state.phase, event }) + '\n', { mode: 0o600 })
}
export function findShipState(root: string, sessionId: string, includeDone = false): ShipWorkflowState | null {
  const dir = join(root, 'tasks'); if (!existsSync(dir)) return null
  const matches: ShipWorkflowState[] = []
  for (const slug of readdirSync(dir)) if (/^ship-[a-z0-9-]+$/.test(slug)) {
    const state = readShipState(root, slug)
    if (state && [state.sessionId, state.orchestratorSessionId].includes(sessionId) && (includeDone || state.phase !== 'done')) matches.push(state)
  }
  return matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null
}
export function readShipArtifacts(root: string, slug: string): Record<string, string> {
  const dir = join(ownedDirectory(root, slug), 'plan'); const result: Record<string, string> = {}; let total = 0
  if (lstatSync(dir).isSymbolicLink()) throw new Error('Plan artifact directory cannot be a symbolic link')
  const base = realpathSync(dir)
  for (const name of SHIP_ARTIFACTS) {
    const file = join(dir, name)
    if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw new Error(`Missing plan artifact: ${name}`)
    const resolved = realpathSync(file); const rel = relative(base, resolved)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Plan artifacts must stay in the workflow directory')
    total += lstatSync(file).size; if (total > 4 * 1024 * 1024) throw new Error('Plan artifacts exceed 4 MiB')
    result[name] = readFileSync(file, 'utf8')
    if (!result[name]!.trim() && name !== 'claims.jsonl') throw new Error(`Empty plan artifact: ${name}`)
  }
  return result
}

/** Authenticated handler chooses the native workflow, never a client-provided file path. */
export function readShipPlanPreview(root: string, state: ShipWorkflowState): ShipPlanPreview {
  if (state.phase !== 'discussion' || state.job) throw new Error('The plan is not ready for human review')
  const artifacts = readShipArtifacts(root, state.id)
  const names = ['plan.md', 'brief.md', 'contract.md'] as const
  const files = names.map(name => { const bytes = Buffer.from(artifacts[name]!, 'utf8'); return { name, contentBase64: bytes.toString('base64'), size: bytes.length } })
  return { planHash: hashShipArtifacts(artifacts), totalBytes: files.reduce((size, file) => size + file.size, 0), files }
}
