/** Git snapshots backing conversation turn checkpoints; no SDK or server paths in the wire format. */
export interface SessionCheckpointSummary {
  id: string
  kind: 'turn' | 'recovery'
  userMessageId?: string
  createdAt: number
  branch: string
  headCommit: string
}
export interface SessionCheckpointList {
  supported: boolean
  reason?: string
  checkpoints: SessionCheckpointSummary[]
}
export interface SessionCheckpointRestoreResult {
  restored: SessionCheckpointSummary
  /** The pre-restore files and conversation remain recoverable through this record. */
  recovery: SessionCheckpointSummary
}
