import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { ShipUsageAttempt, ShipUsageSnapshot } from '../../../shared/src/protocol/ship-usage'
import { runGit } from './git'

const ROLES = new Set(['factcheck', 'omissions', 'bugs', 'comments', 'light'])
const MAX_BYTES = 1024 * 1024
const MAX_REVIEWERS = 100
const MAX_ATTEMPTS = 200
const safeName = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,99}$/.test(value)
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function parseAttempt(value: unknown): ShipUsageAttempt | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !safeName(record.id) || !ROLES.has(String(record.role))
    || !safeName(record.requestedModel) || !(record.servedModel === null || safeName(record.servedModel))
    || record.provider !== 'CLIProxyAPI' || record.accountAttribution !== 'unknown' || !safeName(record.effort)
    || !count(record.round) || record.round < 1 || !count(record.startedAt) || !count(record.durationMs)
    || !['completed', 'failed'].includes(String(record.status))) return null
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens']) if (record[key] !== null && !count(record[key])) return null
  // Whitelist fields: a changed helper/log cannot expose prompt text, credential fields or emails over RPC.
  return {
    id: record.id, role: record.role as ShipUsageAttempt['role'], requestedModel: record.requestedModel,
    servedModel: record.servedModel as string | null, provider: 'CLIProxyAPI', accountAttribution: 'unknown',
    effort: record.effort, round: record.round, startedAt: record.startedAt, durationMs: record.durationMs,
    status: record.status as ShipUsageAttempt['status'], inputTokens: record.inputTokens as number | null,
    outputTokens: record.outputTokens as number | null, cacheReadTokens: record.cacheReadTokens as number | null,
  }
}

async function inside(root: string, path: string): Promise<boolean> {
  const rel = relative(root, await realpath(path))
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Demand-only bounded reads. No provider calls, token refresh, polling or credential access. */
export async function readShipUsage(directory: string): Promise<ShipUsageSnapshot> {
  const result: ShipUsageSnapshot = { coverage: 'codex-helper-only', accountAttribution: 'unknown', attempts: [], truncated: false }
  const checkout = await runGit(directory, ['rev-parse', '--show-toplevel'])
  if (!checkout) return result
  const root = await realpath(checkout)
  const base = join(root, '.context', 'ship', 'reviewers')
  let entries
  try {
    if (!await inside(root, base) || (await lstat(base)).isSymbolicLink()) return result
    entries = await readdir(base, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
    throw error
  }
  const folders = entries.filter(entry => entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name))
  result.truncated = folders.length > MAX_REVIEWERS
  let budget = MAX_BYTES
  for (const entry of folders.slice(0, MAX_REVIEWERS)) {
    if (budget <= 0) { result.truncated = true; break }
    const path = join(base, entry.name, 'usage.jsonl')
    try {
      if (!await inside(root, path) || (await lstat(path)).isSymbolicLink()) continue
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      let content: string
      try {
        const info = await handle.stat()
        if (!info.isFile()) continue
        const bytes = Math.min(info.size, budget)
        const buffer = Buffer.alloc(bytes)
        const { bytesRead } = await handle.read(buffer, 0, bytes, Math.max(0, info.size - bytes))
        budget -= bytesRead
        result.truncated ||= info.size > bytes
        content = buffer.subarray(0, bytesRead).toString('utf8')
      } finally { await handle.close() }
      for (const line of content.split('\n')) {
        try { const attempt = parseAttempt(JSON.parse(line)); if (attempt) result.attempts.push(attempt) } catch {}
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  result.attempts.sort((left, right) => right.startedAt - left.startedAt)
  result.truncated ||= result.attempts.length > MAX_ATTEMPTS
  result.attempts = result.attempts.slice(0, MAX_ATTEMPTS)
  return result
}
