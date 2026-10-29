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
