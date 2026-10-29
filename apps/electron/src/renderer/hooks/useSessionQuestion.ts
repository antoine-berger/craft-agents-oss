import { useCallback, useEffect, useRef, useState } from 'react'
import type { PendingUserQuestion, UserQuestionResponse } from '@craft-agent/core/types'

type QuestionLifecycle = { active: boolean; generation: number; refresh: (preserveError?: boolean) => Promise<void> }

/** Restores only the newest live request; events and owner responses invalidate older reads. */
export function useSessionQuestion(sessionId?: string) {
  const [pending, setPending] = useState<PendingUserQuestion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submittingId, setSubmittingId] = useState<string | null>(null)
  const submittingRef = useRef<string | null>(null)
  const lifecycle = useRef<QuestionLifecycle | null>(null)
  const currentPending = pending?.sessionId === sessionId ? pending : null

  useEffect(() => {
    const token: QuestionLifecycle = { active: true, generation: 0, refresh: async () => {} }
    lifecycle.current = token
    setPending(null)
    setError(null)
    setSubmittingId(null)
    submittingRef.current = null
    if (!sessionId) return () => { token.active = false }

    token.refresh = async (preserveError = false) => {
      const generation = ++token.generation
      try {
        const request = await window.electronAPI.sessionCommand(sessionId, { type: 'getPendingQuestion' })
        if (token.active && generation === token.generation) {
          setPending(request)
          if (!preserveError || !request) setError(null)
        }
      } catch (reason) {
        if (token.active && generation === token.generation && !preserveError) setError(reason instanceof Error ? reason.message : 'Could not load the pending questions')
      }
    }
    const stop = window.electronAPI.onSessionEvent(event => {
      if (event.sessionId !== sessionId || !token.active) return
      if (event.type === 'question_changed') {
        token.generation++
        setPending(event.request)
        setError(null)
      } else if (event.type === 'interrupted' || event.type === 'session_archived' || event.type === 'session_deleted') {
        token.generation++
        setPending(null)
        setError(null)
      } else if (event.type === 'complete') {
        // A live background agent can still await an answer after the foreground finishes.
        void token.refresh()
      }
    })
    const reconnect = window.electronAPI.onReconnected?.(() => { void token.refresh() })
    void token.refresh()
    return () => { token.active = false; stop(); reconnect?.() }
  }, [sessionId])

  const respond = useCallback(async (response: UserQuestionResponse) => {
    const token = lifecycle.current
    if (!sessionId || !currentPending || !token?.active || submittingRef.current === currentPending.requestId) return
    const requestId = currentPending.requestId
    const generation = ++token.generation
    submittingRef.current = requestId
    setSubmittingId(requestId)
    setError(null)
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'respondToQuestion', requestId, response })
      if (token.active) {
        token.generation++
        setPending(previous => previous?.requestId === requestId ? null : previous)
      }
    } catch (reason) {
      if (token.active && generation === token.generation) {
        setError(reason instanceof Error ? reason.message : 'Could not submit the answers')
        await token.refresh(true)
      }
    } finally {
      if (token.active && submittingRef.current === requestId) {
        submittingRef.current = null
        setSubmittingId(null)
      }
    }
  }, [sessionId, currentPending])

  return { pending: currentPending, respond, submitting: Boolean(currentPending && submittingId === currentPending.requestId), error }
}
