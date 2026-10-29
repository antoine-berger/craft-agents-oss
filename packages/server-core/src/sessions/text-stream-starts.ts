/** Runtime-only ordering for prose; final message timestamps keep their existing end-time meaning. */
export class TextStreamStarts {
  private starts = new Map<string, { turnId?: string; timestamp: number }>()

  note(turnId: string | undefined, parentToolUseId: string | undefined, now: () => number, blockId?: string): number {
    const key = this.key(turnId, parentToolUseId, blockId)
    const known = this.starts.get(key)
    if (known) return known.timestamp
    const timestamp = now()
    this.starts.set(key, { turnId, timestamp })
    return timestamp
  }

  take(turnId?: string, parentToolUseId?: string, blockId?: string): number | undefined {
    const key = this.key(turnId, parentToolUseId, blockId)
    const timestamp = this.starts.get(key)?.timestamp
    this.starts.delete(key)
    return timestamp
  }

  discard(turnId: string): void {
    for (const [key, value] of this.starts) if (value.turnId === turnId) this.starts.delete(key)
  }

  clear(): void { this.starts.clear() }

  private key(turnId?: string, parentToolUseId?: string, blockId?: string): string { return JSON.stringify([turnId ?? null, parentToolUseId ?? null, blockId ?? null]) }
}
