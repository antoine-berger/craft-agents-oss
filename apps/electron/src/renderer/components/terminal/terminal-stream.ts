import type { SessionTerminalEvent, SessionTerminalSnapshot } from '@craft-agent/shared/protocol'

/** Sequence guards make snapshot + queued pushes deterministic across an RPC reconnect. */
export class TerminalStream {
  private id: string | null = null
  private sequence = -1
  constructor(private write: (data: string, reset: boolean) => void) {}
  snapshot(snapshot: SessionTerminalSnapshot): boolean {
    if (snapshot.id === this.id && snapshot.sequence < this.sequence) return false
    this.id = snapshot.id
    this.sequence = snapshot.sequence
    this.write(snapshot.output, true)
    return true
  }
  event(event: SessionTerminalEvent): 'applied' | 'ignored' | 'gap' {
    if (event.type === 'snapshot') {
      if (this.id && event.snapshot.id !== this.id) return 'ignored'
      return this.snapshot(event.snapshot) ? 'applied' : 'ignored'
    }
    if (event.id !== this.id || event.sequence <= this.sequence) return 'ignored'
    if (event.sequence !== this.sequence + 1) return 'gap'
    this.sequence = event.sequence
    this.write(event.data, false)
    return 'applied'
  }
}
