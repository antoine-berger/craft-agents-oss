import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AttentionReason, AttentionSource, SessionAttention, WorkspaceAttention } from '../../../../shared/src/protocol/session-attention'

/** One atomic file per workspace. Does not rewrite session records or conversation history. */
export class SessionAttentionStore {
  private states = new Map<string, SessionAttention>()
  private working = new Set<string>()
  private revision = 0
  private listeners = new Set<(snapshot: WorkspaceAttention) => void>()
  constructor(readonly workspaceId: string, private root: string, private now = Date.now) {
    try {
      const saved = JSON.parse(readFileSync(join(root, 'attention.json'), 'utf8'))
      if (Number.isSafeInteger(saved.revision)) this.revision = saved.revision
      if (saved.version === 1 && saved.sessions && typeof saved.sessions === 'object') {
        for (const [id, state] of Object.entries(saved.sessions)) {
          const s = state as SessionAttention
          if (s.sessionId === id && Array.isArray(s.reasons)) {
            // Process activity never survives a restart; confirmed reasons do.
            this.states.set(id, { ...s, status: s.reasons.length ? 'needs-human' : 'idle', githubStale: true })
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  subscribe(listener: (snapshot: WorkspaceAttention) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  snapshot(): WorkspaceAttention { return { workspaceId: this.workspaceId, sessions: Object.fromEntries(this.states), revision: this.revision } }
  get(sessionId: string): SessionAttention | undefined { return this.states.get(sessionId) }
  setWorking(sessionId: string, working: boolean): void {
    if (!working && !this.states.has(sessionId)) return
    if (working) this.working.add(sessionId)
    else this.working.delete(sessionId)
    this.update(sessionId, this.states.get(sessionId)?.reasons ?? [])
  }
  setReasons(sessionId: string, source: AttentionSource, reasons: AttentionReason[]): void {
    const previous = this.states.get(sessionId)
    if (!previous && !reasons.length) return
    const merged = [...(previous?.reasons ?? []).filter(r => r.source !== source), ...reasons.map(r => ({ ...r, source }))]
    this.update(sessionId, merged, source === 'github' ? false : previous?.githubStale)
  }
  setGitHubState(sessionId: string, reasons: AttentionReason[], stale: boolean): void {
    const previous = this.states.get(sessionId)
    if (!previous && !reasons.length) return
    this.update(sessionId, [...(previous?.reasons ?? []).filter(r => r.source !== 'github'), ...reasons], stale)
  }
  markGitHubStale(sessionId: string): void {
    if (!this.states.has(sessionId)) return
    this.update(sessionId, this.states.get(sessionId)?.reasons ?? [], true)
  }
  forget(sessionId: string): void {
    this.working.delete(sessionId)
    if (this.states.delete(sessionId)) this.commit()
  }
  private update(sessionId: string, reasons: AttentionReason[], stale = this.states.get(sessionId)?.githubStale ?? false): void {
    const status = reasons.length ? 'needs-human' : this.working.has(sessionId) ? 'working' : 'idle'
    const previous = this.states.get(sessionId)
    if (previous && previous.status === status && previous.githubStale === stale && JSON.stringify(previous.reasons) === JSON.stringify(reasons)) return
    this.states.set(sessionId, { sessionId, reasons, status, githubStale: stale, updatedAt: this.now() })
    this.commit()
  }
  private commit(): void {
    mkdirSync(this.root, { recursive: true })
    const path = join(this.root, 'attention.json')
    const temp = `${path}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, revision: this.revision + 1, sessions: Object.fromEntries(this.states) }), { mode: 0o600 })
    renameSync(temp, path)
    this.revision++
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}
