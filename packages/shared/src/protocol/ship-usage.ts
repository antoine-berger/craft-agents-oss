export const SHIP_USAGE_CHANNELS = { GET: 'shipUsage:get' } as const

/** Measured Codex helper attempts only; never the whole conversation's/provider account's usage. */
export interface ShipUsageAttempt {
  id: string
  role: 'factcheck' | 'omissions' | 'bugs' | 'comments' | 'light'
  requestedModel: string
  servedModel: string | null
  provider: 'CLIProxyAPI'
  accountAttribution: 'unknown'
  effort: string
  round: number
  startedAt: number
  durationMs: number
  status: 'completed' | 'failed'
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
}

export interface ShipUsageSnapshot {
  coverage: 'codex-helper-only'
  accountAttribution: 'unknown'
  attempts: ShipUsageAttempt[]
  truncated: boolean
}

export interface ShipUsageAPI {
  getShipUsage(sessionId: string): Promise<ShipUsageSnapshot>
}
