/**
 * Pure render-mode decision for the chat-input model picker.
 *
 * The picker has four mutually-exclusive UIs. Centralizing the truth table
 * here keeps the chevron on the trigger button and the popover content
 * branch in agreement, and makes the rule trivially unit-testable.
 *
 * Precedence (highest first):
 *   1. unavailable     — current connection is gone / error state
 *   2. switcher        — multiple connections configured, before the first
 *                        message or with the desktop hierarchy retained
 *   3. locked-single   — `pi_compat` connection with ≤1 model and no
 *                        switcher available (mid-session, or only one
 *                        connection configured)
 *   4. flat            — fall-through: list models for the active connection
 *
 * Note: `switcher` deliberately wins over `locked-single`. Before #727 they
 * were checked in the opposite order, which trapped users whose default was
 * a single-model `pi_compat` connection — they could never reach the
 * switcher even on a fresh chat.
 */

export type PickerMode = 'unavailable' | 'switcher' | 'locked-single' | 'flat'

export interface PickerModeInput {
  connectionUnavailable: boolean
  /** Non-null when the active connection is `pi_compat` with ≤1 model. */
  connectionDefaultModel: string | null
  /** True when the session has no messages yet. */
  isEmptySession: boolean
  /** Total number of configured connections in the workspace. */
  connectionCount: number
  /** Keep the desktop connection hierarchy after the first message. */
  keepHierarchy?: boolean
}

export function derivePickerMode(input: PickerModeInput): PickerMode {
  if (input.connectionUnavailable) return 'unavailable'
  if (input.connectionCount > 1 && (input.isEmptySession || input.keepHierarchy)) return 'switcher'
  if (input.connectionDefaultModel != null) return 'locked-single'
  return 'flat'
}
