import { randomUUID } from 'node:crypto'
import { validateQuestionResponse, type PendingUserQuestion, type UserQuestion, type UserQuestionResponse } from '@craft-agent/core/types'

interface QuestionEntry {
  request: PendingUserQuestion
  resolve: (response: UserQuestionResponse) => void
  reject: (error: Error) => void
  releaseSignal?: () => void
}

/** An awaited tool request lives only as long as its running turn, not in recovered history. */
export class SessionQuestions {
  private pending = new Map<string, QuestionEntry>()

  constructor(private changed: (sessionId: string, request: PendingUserQuestion | null) => void) {}

  private notify(sessionId: string, request: PendingUserQuestion | null): void {
    try {
      this.changed(sessionId, request)
    } catch (error) {
      // The authoritative snapshot remains readable after a transport failure.
      console.error('Could not publish the pending question state', error)
    }
  }

  get(sessionId: string): PendingUserQuestion | null {
    const request = this.pending.get(sessionId)?.request
    return request ? structuredClone(request) : null
  }

  ask(sessionId: string, questions: UserQuestion[], signal?: AbortSignal): Promise<UserQuestionResponse> {
    if (signal?.aborted) return Promise.reject(new Error('The question request was cancelled'))
    if (this.pending.has(sessionId)) return Promise.reject(new Error('This chat already has questions awaiting an answer'))
    const request: PendingUserQuestion = { requestId: randomUUID(), sessionId, questions: structuredClone(questions), createdAt: Date.now() }
    return new Promise((resolve, reject) => {
      const entry: QuestionEntry = { request, resolve, reject }
      this.pending.set(sessionId, entry)
      if (signal) {
        const aborted = () => {
          if (this.pending.get(sessionId) === entry) this.cancel(sessionId, 'The question tool was cancelled before an answer')
        }
        signal.addEventListener('abort', aborted, { once: true })
        entry.releaseSignal = () => signal.removeEventListener('abort', aborted)
      }
      this.notify(sessionId, structuredClone(request))
    })
  }

  answer(sessionId: string, requestId: string, input: unknown): boolean {
    const entry = this.pending.get(sessionId)
    if (!entry || entry.request.requestId !== requestId) throw new Error('These questions are no longer pending. The chat may have stopped or restarted.')
    const response = validateQuestionResponse(entry.request.questions, input)
    entry.releaseSignal?.()
    this.pending.delete(sessionId)
    this.notify(sessionId, null)
    entry.resolve(response)
    return true
  }

  cancel(sessionId: string, reason = 'The chat stopped before the questions were answered'): void {
    const entry = this.pending.get(sessionId)
    if (!entry) return
    entry.releaseSignal?.()
    this.pending.delete(sessionId)
    this.notify(sessionId, null)
    entry.reject(new Error(reason))
  }

  dispose(): void {
    for (const sessionId of this.pending.keys()) this.cancel(sessionId, 'The server is shutting down')
  }
}
