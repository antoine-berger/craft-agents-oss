import { afterEach, beforeEach, expect, test } from 'bun:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import type { ProviderAccountQuota, ProviderQuotasRequest, ProviderQuotasSnapshot } from '@craft-agent/shared/protocol'
import { mergeQuotaSnapshot, quotaCacheScope, quotaRefreshDue, quotaStorageKey, readQuotaDisplay, saveQuotaDisplay } from '../quota-display-state'
import { useQuotaDisplay } from '../useQuotaDisplay'

let now: number, result: ReturnType<typeof useQuotaDisplay>, root: ReturnType<typeof create> | undefined
let callbacks: Set<() => void>, connected: Set<(state: any) => void>, storage: Map<string, string>
let calls: ProviderQuotasRequest[], server: ProviderAccountQuota[], offline: boolean, unavailable: boolean
let original: Record<string, PropertyDescriptor | undefined>, oldNow: typeof Date.now
const account = (id: string, used: number | null = null, provider: 'claude' | 'codex' = 'claude'): ProviderAccountQuota => ({ accountId: id, name: id, provider, disabled: false,
  state: used === null ? 'unavailable' : 'ready', freshness: used === null ? 'never' : 'fresh', availability: used === null ? 'unknown' : 'available',
  observedAt: used === null ? null : now, checkedAt: used === null ? null : now, nextRefreshAt: used === null ? null : now + 30000,
  windows: used === null ? [] : [{ id: 'five_hour', label: '5h', period: 'five_hour', usedPercent: used, resetsAt: null, durationSeconds: 18000 }] })
const snapshot = (accounts: ProviderAccountQuota[], serviceAvailable = true): ProviderQuotasSnapshot => ({ accounts, serviceAvailable, generatedAt: now })
const getQuotas = async (request: ProviderQuotasRequest = {}) => {
  calls.push(request)
  if (offline) throw new Error('disconnected')
  if (unavailable) return snapshot([], false)
  if (request.refresh) server = server.map(value => value.accountId === request.accountId ? account(value.accountId, value.accountId === 'a' ? 25 : 75) : value)
  return snapshot(server)
}
function Probe({ scope = 'server-one', reader = getQuotas }: { scope?: string; reader?: typeof getQuotas }) { result = useQuotaDisplay(reader, scope); return null }
async function mount(scope?: string) { await act(async () => { root = create(<Probe key={scope} scope={scope} />) }) }
async function tick(ms = 60000) { now += ms; await act(async () => { for (const cb of callbacks) cb() }) }
beforeEach(() => {
  original = Object.fromEntries(['window', 'document', 'localStorage', 'setInterval', 'clearInterval'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  oldNow = Date.now; now = 1_800_000_000_000; Date.now = () => now
  storage = new Map(); callbacks = new Set(); connected = new Set(); calls = []; offline = false; unavailable = false
  server = [account('a'), account('b')]
  Object.assign(globalThis, { document: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
    window: Object.assign(new EventTarget(), { electronAPI: { onTransportConnectionStateChanged: (cb: any) => { connected.add(cb); return () => connected.delete(cb) } } }),
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    setInterval: (cb: () => void) => { callbacks.add(cb); return cb }, clearInterval: (cb: () => void) => callbacks.delete(cb) })
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount()); root = undefined; Date.now = oldNow
  for (const [key, descriptor] of Object.entries(original)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key] }
})

test('mount and minute timer refresh only the selected account; focus bursts and hidden app do not over-poll', async () => {
  await mount()
  expect(calls).toEqual([{ refresh: false }, { refresh: true, accountId: 'a' }])
  await act(async () => { for (let n = 0; n < 10; n++) window.dispatchEvent(new Event('focus')) })
  expect(calls).toHaveLength(2)
  await tick()
  expect(calls.at(-1)).toEqual({ refresh: true, accountId: 'a' })
  Object.assign(document, { visibilityState: 'hidden' }); await tick()
  expect(calls).toHaveLength(3)
  Object.assign(document, { visibilityState: 'visible' })
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(calls).toHaveLength(4)
})

test('selection refreshes the new account and persists both independent observations across remount and failures', async () => {
  await mount()
  await act(async () => { result.setSelectedId('b') })
  expect(calls.at(-1)).toEqual({ refresh: true, accountId: 'b' })
  expect(result.snapshot!.accounts.map(value => value.windows[0]?.usedPercent)).toEqual([25, 75])
  await act(async () => root!.unmount()); root = undefined; offline = true
  await mount()
  expect(result.selectedId).toBe('b')
  expect(result.snapshot!.accounts.map(value => value.windows[0]?.usedPercent)).toEqual([25, 75])
  expect(result.failed).toBe(true)
  expect(callbacks.size).toBe(1); expect(connected.size).toBe(1)
})

test('transport reconnect restores an empty backend cache then refreshes the selected account only', async () => {
  await mount(); await act(async () => { result.setSelectedId('b') })
  server = [account('a'), account('b')]
  await act(async () => { for (const cb of connected) cb({ status: 'connected' }) })
  expect(calls.at(-1)).toEqual({ refresh: true, accountId: 'b' })
  expect(result.snapshot!.accounts.map(value => value.windows[0]?.usedPercent)).toEqual([25, 75])
})

test('offline account service and initial RPC failure retry on the bounded timer without a request loop', async () => {
  offline = true; await mount(); expect(calls).toHaveLength(1)
  offline = false; await tick(); expect(result.snapshot?.accounts[0]?.windows[0]?.usedPercent).toBe(25)
  unavailable = true; await tick(); expect(calls).toHaveLength(4)
  expect(result.snapshot?.accounts[0]?.windows[0]?.usedPercent).toBe(25)
  await act(async () => { window.dispatchEvent(new Event('focus')) }); expect(calls).toHaveLength(4)
})

test('cooldowns and Retry-After remain authoritative; cache keys strip credentials and isolate servers', async () => {
  const limited = { ...account('a', 90), state: 'rate_limited' as const, nextRefreshAt: now + 300000 }
  saveQuotaDisplay('server-one', snapshot([limited]), 'a'); server = [limited]
  await mount(); await tick(); expect(calls).toEqual([{ refresh: false }])
  expect(quotaRefreshDue(limited, now)).toBe(false)
  expect(quotaCacheScope('wss://user:password@example.com/rpc?token=secret', 'w')).toBe('wss://example.com/rpc:w')
  expect(readQuotaDisplay('different-server').snapshot).toBeUndefined()
})

test('merging never transfers another provider or account data, invents a zero or resurrects removed accounts', () => {
  const old = snapshot([account('a', 25), account('b', 75)])
  expect(mergeQuotaSnapshot(old, snapshot([account('a')])).accounts[0]?.windows[0]?.usedPercent).toBe(25)
  expect(mergeQuotaSnapshot(old, snapshot([account('a', null, 'codex')])).accounts[0]?.windows).toEqual([])
  expect(mergeQuotaSnapshot(old, snapshot([])).accounts).toEqual([])
  expect(mergeQuotaSnapshot(old, snapshot([], false)).accounts).toHaveLength(2)
})

test('an older window cannot overwrite newer observations saved by another window', () => {
  const earlier = snapshot([account('a', 25), account('b', 75)])
  now += 60000; saveQuotaDisplay('server-one', snapshot([account('a', 30), account('b', 80)]), 'b')
  saveQuotaDisplay('server-one', earlier, 'a')
  expect(readQuotaDisplay('server-one').snapshot!.accounts.map(value => value.windows[0]?.usedPercent)).toEqual([30, 80])
  storage.set(quotaStorageKey('broken'), '{'); expect(readQuotaDisplay('broken').snapshot).toBeUndefined()
})

test('upgrading preserves the account previously selected in the existing meter', async () => {
  storage.set('craft.quota-display-account', 'b')
  await mount()
  expect(result.selectedId).toBe('b')
  expect(calls.at(-1)).toEqual({ refresh: true, accountId: 'b' })
})

test('a late reply from a previous server cannot overwrite the newly selected server', async () => {
  let finish!: (value: ProviderQuotasSnapshot) => void
  const pending = new Promise<ProviderQuotasSnapshot>(resolve => { finish = resolve })
  await act(async () => { root = create(<Probe key="old" scope="old-server" reader={() => pending} />) })
  server = [account('b', 75)]
  await act(async () => { root!.update(<Probe key="new" scope="new-server" />) })
  await act(async () => { finish(snapshot([account('a', 25)])); await Promise.resolve() })
  expect(result.snapshot?.accounts.map(value => value.accountId)).toEqual(['b'])
  expect(readQuotaDisplay('old-server').snapshot).toBeUndefined()
  expect(readQuotaDisplay('new-server').snapshot?.accounts[0]?.windows[0]?.usedPercent).toBe(75)
})

test('manual refresh recovers the account inventory immediately after a failed initial read', async () => {
  offline = true; await mount(); expect(calls).toHaveLength(1)
  offline = false
  await act(async () => { await result.refresh(true) })
  expect(calls.slice(1)).toEqual([{ refresh: false }, { refresh: true, accountId: 'a' }])
  expect(result.snapshot?.accounts[0]?.windows[0]?.usedPercent).toBe(25)
})

test('changing selection during a pending request retains that selection and refreshes the new account next', async () => {
  let finish!: (value: ProviderQuotasSnapshot) => void
  const pending = new Promise<ProviderQuotasSnapshot>(resolve => { finish = resolve })
  const reader = async (request: ProviderQuotasRequest = {}) => request.refresh && request.accountId === 'a' ? pending : getQuotas(request)
  await act(async () => { root = create(<Probe reader={reader} />) })
  await act(async () => { result.setSelectedId('b') })
  server = [account('a', 25), account('b')]
  await act(async () => { finish(snapshot(server)); await Promise.resolve() })
  expect(result.selectedId).toBe('b')
  expect(calls.at(-1)).toEqual({ refresh: true, accountId: 'b' })
  expect(result.snapshot?.accounts.map(value => value.windows[0]?.usedPercent)).toEqual([25, 75])
})
