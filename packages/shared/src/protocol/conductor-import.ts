import type { SessionBundle } from '../sessions/bundle'
import type { RepositorySelection } from './git-repos'

export interface ConductorImportOrigin {
  provider: 'conductor'
  sourceId: string
  sessionId: string
  workspaceId?: string
  repositoryId?: string
  /** Display identity only; does not grant ownership of the imported checkout. */
  repository?: string
  importedAt: number
  fingerprint: string
  partial?: boolean
}
export interface ConductorListOptions { databasePath?: string; cursor?: number; limit?: number; search?: string }
export interface ConductorChatPreview {
  id: string
  title: string
  repositoryId?: string
  repositoryName?: string
  repository?: string
  workspaceId?: string
  workspaceName?: string
  createdAt?: number
  updatedAt: number
  archived: boolean
  hidden: boolean
  partial: boolean
}
export interface ConductorChatList {
  chats: ConductorChatPreview[]
  total: number
  nextCursor?: number
  warnings: string[]
}
export interface ConductorExportOptions { databasePath?: string }
export interface ConductorImportBundle {
  version: 1
  origin: ConductorImportOrigin
  preview: ConductorChatPreview
  bundle: SessionBundle
  warnings: string[]
}
export interface ConductorImportOptions {
  /** Omit to create/reuse a project for the source repository. */
  projectId?: string
  /** Required on continuation if the original repository cannot be recognized. */
  repository?: RepositorySelection
}
export interface ConductorImportResult { status: 'imported' | 'skipped'; sessionId: string; projectId?: string; warnings: string[] }
