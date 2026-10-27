/** Server-owned, durable reasons a person must act. Reading a chat never acknowledges these. */
export const SESSION_ATTENTION_CHANNELS = { GET: 'attention:get', CHANGED: 'attention:changed' } as const
export type AttentionSource = 'permission' | 'auth' | 'agent' | 'github' | 'ship'
export type AttentionKind = 'permission' | 'authentication' | 'question' | 'plan' | 'error' | 'review' | 'ci' | 'ship'
export interface AttentionReason {
  id: string
  source: AttentionSource
  kind: AttentionKind
  title: string
  detail?: string
  createdAt: number
  action: { type: 'session' | 'external'; url?: string }
}
export interface SessionAttention {
  sessionId: string
  status: 'needs-human' | 'working' | 'idle'
  reasons: AttentionReason[]
  /** Previously confirmed GitHub reasons are retained while GitHub cannot be checked. */
  githubStale: boolean
  updatedAt: number
}
export interface WorkspaceAttention {
  workspaceId: string
  sessions: Record<string, SessionAttention>
  revision: number
}
