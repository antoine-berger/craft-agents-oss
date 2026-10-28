import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PrSummary } from '@craft-agent/shared/protocol'
import { parsePrReference } from './pr-ref'
import type { RepoCoordinates } from './remote-url'

/** Durable identity only: no review bodies, CI details, credentials, or in-memory catalogue. */
export interface PrAssociation {
  coords: RepoCoordinates
  number: number
  title: string
  url: string
  headRef: string
  baseRef: string
  headOid: string
  state: PrSummary['state']
  fetchedAt: number
  via: string
}

export interface PrAssociationStore {
  load(root: string, key: string): PrAssociation | null
  save(root: string, key: string, association: PrAssociation): void
}

export function prAssociationPath(root: string, key: string): string {
  return join(root, 'pr-associations', createHash('sha256').update(key).digest('hex') + '.json')
}

export function associatePr(coords: RepoCoordinates, summary: PrSummary): PrAssociation {
  const { number, title, url, headRef, baseRef, state, fetchedAt, via } = summary
  return { coords, number, title, url, headRef, baseRef, headOid: summary.headOid ?? '', state, fetchedAt, via }
}

/** Link remains usable offline; CI, permissions and local checkout are explicitly unverified. */
export function savedPrSummary(association: PrAssociation): PrSummary {
  const { coords: _coords, ...summary } = association
  return { ...summary, checks: 'none', reviewDecision: 'review_required', mergeState: 'unknown',
    unresolvedThreads: 0, localAhead: 0, localDirty: false, headMatchesLocal: null, attentionStale: true }
}

function valid(value: unknown): value is PrAssociation {
  if (!value || typeof value !== 'object') return false
  const a = value as PrAssociation
  if (!a.coords || !['host', 'owner', 'repo'].every(k => typeof a.coords[k as keyof RepoCoordinates] === 'string')) return false
  if (!Number.isSafeInteger(a.number) || a.number <= 0 || !Number.isFinite(a.fetchedAt)) return false
  if (!['title', 'url', 'headRef', 'baseRef', 'headOid', 'via'].every(k => typeof a[k as keyof PrAssociation] === 'string')) return false
  if (!['open', 'draft', 'merged', 'closed'].includes(a.state)) return false
  const ref = parsePrReference(a.url)
  return !!ref && ref.number === a.number && ref.host === a.coords.host.toLowerCase()
    && ref.owner.toLowerCase() === a.coords.owner.toLowerCase() && ref.repo.toLowerCase() === a.coords.repo.toLowerCase()
}

export const diskPrAssociations: PrAssociationStore = {
  load(root, key) {
    const path = prAssociationPath(root, key)
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.size > 16 * 1024) return null
      const record = JSON.parse(readFileSync(path, 'utf8'))
      return record.version === 1 && record.key === key && valid(record.association) ? record.association : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null
      throw error
    }
  },
  save(root, key, association) {
    if (!valid(association)) throw new Error('Invalid PR association')
    const previous = this.load(root, key)
    if (previous) {
      // Do not rewrite durable identity on every polling tick or overwrite newer observations.
      if (previous.fetchedAt > association.fetchedAt) return
      const identity = ({ fetchedAt: _age, ...rest }: PrAssociation) => JSON.stringify(rest)
      if (identity(previous) === identity(association)) return
    }
    const directory = join(root, 'pr-associations')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = prAssociationPath(root, key), temp = `${path}.${randomUUID()}.tmp`
    try {
      const fd = openSync(temp, 'wx', 0o600)
      try { writeFileSync(fd, JSON.stringify({ version: 1, key, association }) + '\n'); fsyncSync(fd) }
      finally { closeSync(fd) }
      renameSync(temp, path)
      if (process.platform !== 'win32') {
        const directoryFd = openSync(directory, 'r')
        try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
      }
    } finally { try { unlinkSync(temp) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
  },
}
