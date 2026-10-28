import type { PrWatchSessionState } from '@craft-agent/shared/protocol'

/** Remember each checkout's last result while its subscription reconnects. */
export class PrWatchSnapshots {
  private values = new Map<string, PrWatchSessionState>()

  read(key: string): PrWatchSessionState {
    const previous = this.values.get(key)
    if (previous?.kind !== 'ready') return { kind: 'loading' }
    // A cached snapshot is useful for display, never proof that a merge is safe.
    return { ...previous, prs: previous.prs.map(pr => ({ ...pr, summary: { ...pr.summary, attentionStale: true } })) }
  }

  update(key: string, next: PrWatchSessionState): PrWatchSessionState {
    const transient = next.kind === 'loading' || (next.kind === 'unavailable' && next.reason === 'error')
    if (transient && this.values.get(key)?.kind === 'ready') return this.read(key)
    if (!transient) {
      this.values.delete(key)
      this.values.set(key, next)
      if (this.values.size > 100) this.values.delete(this.values.keys().next().value!)
    }
    return next
  }
}
