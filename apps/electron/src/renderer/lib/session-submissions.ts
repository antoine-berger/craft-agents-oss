import type { Message } from '@craft-agent/core/types'
import type { FileAttachment } from '@craft-agent/shared/protocol'
import type { SessionDraft } from '@craft-agent/shared/config'
import { toDraftRef } from './drafts'

export const CANCEL_SESSION_SUBMISSIONS = 'craft:cancel-session-submissions'
export class SubmissionCancelled extends Error {
  constructor() { super('Submission cancelled before dispatch'); this.name = 'SubmissionCancelled' }
}

/** Serializes preparation through the persisted send RPC ACK, never through the AI turn. */
export class SessionSubmissions {
  private lanes = new Map<string, { tail: Promise<void>; epoch: number }>()

  run<T>(sessionId: string, work: (check: () => void) => Promise<T>): Promise<T> {
    const lane = this.lanes.get(sessionId) ?? { tail: Promise.resolve(), epoch: 0 }
    this.lanes.set(sessionId, lane)
    const epoch = lane.epoch
    const result = lane.tail.then(() => work(() => { if (epoch !== lane.epoch) throw new SubmissionCancelled() }))
    const tail = result.then(() => {}, () => {})
    lane.tail = tail
    void tail.then(() => { if (this.lanes.get(sessionId) === lane && lane.tail === tail) this.lanes.delete(sessionId) })
    return result
  }

  cancel(sessionId: string): void {
    const lane = this.lanes.get(sessionId)
    if (lane) lane.epoch++
  }
}

/** Recovery must preserve the full submitted payload, including an oversized pasted attachment. */
export function recoverSubmissionDraft(existing: SessionDraft | undefined, text: string, attachments: FileAttachment[] = []): SessionDraft {
  const refs = attachments.map(attachment => {
    const ref = toDraftRef(attachment)
    if (ref) return ref
    const { path, name, ...content } = attachment
    return { path, name, content }
  })
  const all = [...(existing?.attachments ?? []), ...refs]
  return { text: [existing?.text, text].filter(Boolean).join('\n\n'), ...(all.length ? { attachments: all } : {}) }
}

/** Only a session's first submission can still choose its repository. */
export function canChooseSubmissionRepository(session: { isProcessing?: boolean; messages: { role: string }[] } | null | undefined): boolean {
  return !session?.isProcessing && !session?.messages.some(message => message.role === 'user')
}

/** Remove only this attempt when it has not already been confirmed by a backend event. */
export function discardPendingSubmission(messages: Message[], messageId: string | undefined): Message[] {
  return messages.filter(message => message.id !== messageId || !message.isPending)
}

/** The persisted RPC acknowledgement confirms delivery even if its UI event was missed. */
export function confirmPendingSubmission(messages: Message[], messageId: string): Message[] {
  return messages.map(message => message.id === messageId && message.isPending
    ? { ...message, isPending: false } : message)
}

/** A late draft-file read must keep attachments restored while that read was in flight. */
export function mergeHydratedAttachments(hydrated: FileAttachment[], current: FileAttachment[]): FileAttachment[] {
  return [...hydrated.filter(file => !current.some(value => value.path === file.path && value.name === file.name
    && value.base64 === file.base64 && value.text === file.text)), ...current]
}
