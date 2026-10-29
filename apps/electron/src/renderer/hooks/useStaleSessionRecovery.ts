/** Reconcile visible chats with server metadata without sending agent prompts. */
import { useCallback, useEffect, useRef } from 'react'
import { getDefaultStore } from 'jotai'
import { sessionAtomFamily, sessionMetaMapAtom, updateSessionMetaAtom } from '@/atoms/sessions'
import { visibleSessionIdsAtom } from '@/atoms/panel-stack'

type JotaiStore = ReturnType<typeof getDefaultStore>
type RefreshResult = 'refreshed' | 'preserved_stale_messages' | 'failed'
const CHECK_INTERVAL_MS = 30_000
const isVisible = () => document.visibilityState !== 'hidden'

interface UseStaleSessionRecoveryOptions {
  store: JotaiStore
  refreshSessionFromServer: (sessionId: string, canApply?: () => boolean) => Promise<RefreshResult>
}

export function useStaleSessionRecovery({ store, refreshSessionFromServer }: UseStaleSessionRecoveryOptions) {
  const eventRevisions = useRef(new Map<string, number>())
  const trackSessionActivity = useCallback((sessionId: string) => {
    eventRevisions.current.set(sessionId, (eventRevisions.current.get(sessionId) ?? 0) + 1)
  }, [])

  useEffect(() => {
    let checking = false
    let disposed = false
    const check = async () => {
      const visible = new Set(store.get(visibleSessionIdsAtom))
      if (checking || !isVisible()) return
      checking = true
      const beforeMeta = new Map(store.get(sessionMetaMapAtom))
      const revisions = new Map(eventRevisions.current)
      const unchanged = (id: string) => (eventRevisions.current.get(id) ?? 0) === (revisions.get(id) ?? 0)
      const isCurrent = (id: string) => !disposed && isVisible() && store.get(visibleSessionIdsAtom).has(id)
        && unchanged(id)
      try {
        // Read metadata once. Only reload a visible transcript when it actually differs.
        const snapshots = await window.electronAPI.getSessions()
        if (disposed || !isVisible()) return
        for (const snapshot of snapshots) {
          if (disposed || !isVisible()) return
          if (!visible.has(snapshot.id)) {
            const meta = store.get(sessionMetaMapAtom).get(snapshot.id)
            if (meta && !meta.isArchived && meta === beforeMeta.get(snapshot.id) && unchanged(snapshot.id)
              && (!!meta.isProcessing !== !!snapshot.isProcessing || (meta.backgroundAgentCount ?? 0) !== (snapshot.backgroundAgentCount ?? 0))) {
              store.set(updateSessionMetaAtom, snapshot.id, { isProcessing: snapshot.isProcessing, backgroundAgentCount: snapshot.backgroundAgentCount })
            }
            continue
          }
          if (!isCurrent(snapshot.id)) continue
          const local = store.get(sessionAtomFamily(snapshot.id))
          if (!local || local.isArchived || local.messages.some(message => message.role === 'user' && message.isPending)) continue
          const missingFinal = snapshot.lastFinalMessageId && !local.messages.some(message => message.id === snapshot.lastFinalMessageId)
          const queuedCount = local.messages.filter(message => message.role === 'user' && message.isQueued).length
          if (!!snapshot.isProcessing === !!local.isProcessing && !missingFinal
            && (snapshot.messageCount ?? local.messages.length) === local.messages.length
            && (snapshot.queuedMessageCount ?? queuedCount) === queuedCount
            && (snapshot.backgroundAgentCount ?? 0) === (local.backgroundAgentCount ?? 0)) continue
          await refreshSessionFromServer(snapshot.id, () => isCurrent(snapshot.id))
        }
      } catch (err) {
        console.warn('[SessionSync] Visible chat metadata check unavailable:', err)
      } finally { checking = false }
    }
    const wake = () => { void check() }
    const timer = setInterval(wake, CHECK_INTERVAL_MS)
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      disposed = true
      clearInterval(timer)
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [store, refreshSessionFromServer])

  return { trackSessionActivity }
}
