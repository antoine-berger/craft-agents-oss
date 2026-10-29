import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderQuotasRequest, ProviderQuotasSnapshot } from '@craft-agent/shared/protocol'
import { mergeQuotaSnapshot, QUOTA_REFRESH_MS, quotaRefreshDue, readQuotaDisplay, saveQuotaDisplay } from './quota-display-state'

type GetQuotas = (request?: ProviderQuotasRequest) => Promise<ProviderQuotasSnapshot>

/** One selected-account refresh per minute; server cooldown/backoff applies across app windows. */
export function useQuotaDisplay(getQuotas: GetQuotas, scope: string) {
  const [initial] = useState(() => readQuotaDisplay(scope))
  const [snapshot, setSnapshot] = useState(initial.snapshot)
  const [selectedId, setSelectedId] = useState<string | null>(initial.selectedId)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [clock, setClock] = useState(Date.now)
  const state = useRef({ snapshot, selectedId })
  state.current = { snapshot, selectedId }
  const request = useRef(getQuotas)
  request.current = getQuotas
  const mounted = useRef(false)
  const pending = useRef(false)
  const lastFailureAt = useRef({ accountId: '', at: 0 })
  const selected = snapshot?.accounts.find(account => !account.disabled && account.accountId === selectedId)
    ?? snapshot?.accounts.find(account => !account.disabled)

  const refresh = useCallback(async (manual = false, cachedOnly = false) => {
    if (pending.current || !mounted.current) return
    const current = state.current
    const account = current.snapshot?.accounts.find(value => !value.disabled && value.accountId === current.selectedId)
      ?? current.snapshot?.accounts.find(value => !value.disabled)
    const readCacheOnly = cachedOnly || (manual && !account)
    if (!readCacheOnly && (!account || (!manual && (!quotaRefreshDue(account, Date.now()) || (lastFailureAt.current.accountId === account.accountId && Date.now() - lastFailureAt.current.at < QUOTA_REFRESH_MS))))) return
    pending.current = true
    setBusy(true)
    try {
      const incoming = await request.current({ refresh: !readCacheOnly, ...(!readCacheOnly ? { accountId: account!.accountId } : {}) })
      if (!mounted.current) return
      const value = mergeQuotaSnapshot(state.current.snapshot, incoming)
      state.current = { ...state.current, snapshot: value }
      setSnapshot(value)
      saveQuotaDisplay(scope, value, state.current.selectedId)
      setFailed(false)
      lastFailureAt.current = incoming.serviceAvailable ? { accountId: '', at: 0 } : { accountId: account?.accountId ?? '', at: Date.now() }
    } catch {
      if (mounted.current) { setFailed(true); lastFailureAt.current = { accountId: account?.accountId ?? '', at: Date.now() } }
    } finally {
      pending.current = false
      if (mounted.current) { setBusy(false); setClock(Date.now()) }
    }
  }, [scope])

  useEffect(() => {
    mounted.current = true
    void refresh(false, true)
    const tick = () => {
      setClock(Date.now())
      if (document.visibilityState !== 'hidden') void refresh(false, !state.current.snapshot?.accounts.some(account => !account.disabled))
    }
    const reconnect = () => { if (document.visibilityState !== 'hidden') void refresh(false, true) }
    const timer = setInterval(tick, QUOTA_REFRESH_MS)
    window.addEventListener('focus', tick)
    window.addEventListener('online', reconnect)
    document.addEventListener('visibilitychange', tick)
    const off = window.electronAPI?.onTransportConnectionStateChanged?.(value => { if (value.status === 'connected') reconnect() })
    return () => {
      mounted.current = false
      clearInterval(timer)
      window.removeEventListener('focus', tick)
      window.removeEventListener('online', reconnect)
      document.removeEventListener('visibilitychange', tick)
      off?.()
    }
  }, [refresh])
  useEffect(() => {
    if (!busy && document.visibilityState !== 'hidden') void refresh()
  }, [selected?.accountId, busy, refresh])
  useEffect(() => { if (snapshot) saveQuotaDisplay(scope, snapshot, selectedId) }, [scope, snapshot, selectedId])
  return { snapshot, selectedId, setSelectedId, busy, failed, refresh, clock }
}
