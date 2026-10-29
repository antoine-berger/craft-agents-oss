import type { UserQuestionResponse } from '@craft-agent/core/types'
import type { UserQuestionInput } from './UserQuestionRequest'
import type { PermissionRequest, CredentialRequest, CredentialResponse } from '../../../../../shared/types'
import type { AdminApprovalRequestData } from './AdminApprovalRequest'

/**
 * Input mode determines which component is rendered in InputContainer
 */
export type InputMode = 'freeform' | 'structured'

/**
 * Types of structured input UIs
 */
export type StructuredInputType = 'permission' | 'credential' | 'admin_approval' | 'question'

/**
 * Union type for structured input data
 */
export type StructuredInputData =
  | { type: 'question'; data: UserQuestionInput }
  | { type: 'permission'; data: PermissionRequest }
  | { type: 'credential'; data: CredentialRequest }
  | { type: 'admin_approval'; data: AdminApprovalRequestData }

/**
 * State for structured input
 */
export interface StructuredInputState {
  type: StructuredInputType
  data: PermissionRequest | CredentialRequest | AdminApprovalRequestData | UserQuestionInput
}

/**
 * Response from permission request
 */
export interface PermissionResponse {
  type: 'permission'
  allowed: boolean
  alwaysAllow: boolean
}

/**
 * Response from admin approval request
 */
export interface AdminApprovalResponse {
  type: 'admin_approval'
  approved: boolean
  rememberForMinutes?: number
}

/**
 * Union type for all structured responses
 */
export type StructuredResponse = PermissionResponse | CredentialResponse | AdminApprovalResponse | { type: 'question'; response: UserQuestionResponse }

// Re-export CredentialResponse for convenience
export type { CredentialResponse }
