import { beforeEach, afterEach, expect, test } from 'bun:test'
import * as React from 'react'
import { create, act } from 'react-test-renderer'
import { usePrWatch, type PrWatch } from '../usePrWatch'
import { nextPrQuickAction } from '../../components/app-shell/chat-header/pr-watch/pr-quick-actions'
import type { PrWatchSessionState, PrEntry } from '@craft-agent/shared/protocol'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return {promise, resolve} }
const entry = (number: number, origin: PrEntry['origin'] = 'branch'): PrEntry => ({ id: `a/b#${number}`, origin, summary: {
 number, title: `PR ${number}`, url: `https://github.com/a/b/pull/${number}`, state: 'open', headRef: 'topic', baseRef: 'main',
 checks:'success', reviewDecision:'approved', mergeState:'clean', unresolvedThreads:0,localAhead:0,localDirty:false,
 fetchedAt:number,via:'gh',headOid:`commit${number}`,headMatchesLocal:true
}})
const ready = (...prs: PrEntry[]): PrWatchSessionState => ({ kind:'ready',prs })
let result: PrWatch
let root: ReturnType<typeof create> | undefined
let requests: Array<{session:string; foreground?:boolean; result:ReturnType<typeof deferred<any>>}>
let listeners: Set<(id:string,state:PrWatchSessionState)=>void>
let reconnected: Set<(stale:boolean)=>void>
let active: Set<string>
let unsubscribed: string[]
let refreshes: number
let automaticRefreshes: Array<boolean | undefined>
let originalWindow: PropertyDescriptor | undefined
let originalDocument: PropertyDescriptor | undefined
function Probe({session,dir='/repo',foreground=true}:{session:string;dir?:string;foreground?:boolean}) { result=usePrWatch(session,true,dir,foreground); return null }
async function mount(session:string,dir='/repo',foreground=true) { await act(async()=>{root=create(React.createElement(Probe,{session,dir,foreground}))}) }
async function update(session:string,dir='/repo') { await act(async()=>{root!.update(React.createElement(Probe,{session,dir}))}) }
async function resolve(index:number,state:PrWatchSessionState) {
 await act(async()=>{ const id=`sub-${index}`;active.add(id);requests[index]!.result.resolve({subscriptionId:id,state});await Promise.resolve() })
}
async function push(session:string,state:PrWatchSessionState) { await act(async()=>{for(const cb of listeners)cb(session,state)}) }
beforeEach(()=>{
 originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
 originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
 requests=[];listeners=new Set();reconnected=new Set();active=new Set();unsubscribed=[];refreshes=0;automaticRefreshes=[]
 const documentMock=new EventTarget();Object.assign(documentMock,{visibilityState:'visible'});(globalThis as any).document=documentMock
 ;(globalThis as any).window=Object.assign(new EventTarget(), {electronAPI:{
  onPrWatchChanged:(cb:any)=>{listeners.add(cb);return ()=>listeners.delete(cb)},
  prWatchSubscribe:(session:string,foreground?:boolean)=>{const next=deferred<any>();requests.push({session,foreground,result:next});return next.promise},
  prWatchUnsubscribe:async(id:string)=>{active.delete(id);unsubscribed.push(id)},
  prWatchRefresh:async(_session:string,automatic?:boolean)=>{refreshes++;automaticRefreshes.push(automatic)},
  onReconnected:(cb:any)=>{reconnected.add(cb);return()=>reconnected.delete(cb)},
 }})
})
afterEach(async () => {
 if (root) await act(async () => root!.unmount())
 root = undefined
 for (const [key, descriptor] of [['window', originalWindow], ['document', originalDocument]] as const) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor)
  else delete (globalThis as any)[key]
 }
})
test('switching sessions ignores late replies and cleans their subscriptions',async()=>{
 await mount('switch-A');await update('switch-B')
 await resolve(0,ready(entry(1)))
 expect(result!.state.kind).toBe('loading');expect(unsubscribed).toContain('sub-0')
 await resolve(1,ready(entry(2)))
 expect(result!.state.kind==='pr'&&result!.state.summary.number).toBe(2)
 await push('switch-A',ready(entry(3)))
 expect(result!.state.kind==='pr'&&result!.state.summary.number).toBe(2)
})
test('returning to a chat keeps its PR visible and marks cached data stale',async()=>{
 await mount('return-A');await resolve(0,ready(entry(11)))
 await update('return-B');await resolve(1,ready(entry(12)))
 await update('return-A')
 expect(result!.state.kind==='pr'&&result!.state.summary.number).toBe(11)
 expect(result!.state.kind==='pr'&&result!.state.summary.attentionStale).toBe(true)
 await resolve(2,ready(entry(11)))
 expect(result!.state.kind==='pr'&&result!.state.summary.attentionStale).toBeUndefined()
})
test('a completed push wins over an older subscribe snapshot',async()=>{
 await mount('push-newer');await push('push-newer',ready(entry(21)));await resolve(0,ready(entry(20)))
 expect(result!.state.kind==='pr'&&result!.state.summary.number).toBe(21)
})
test('changing checkout never displays the old checkout PR',async()=>{
 await mount('checkout','/old');await resolve(0,ready(entry(31)));await update('checkout','/new')
 expect(result!.state.kind).toBe('loading');await resolve(1,ready(entry(32)))
 expect(result!.state.kind==='pr'&&result!.state.summary.number).toBe(32)
})
test('a partial bound-PR push must not hide the branch PR in the completed subscribe result',async()=>{
 await mount('partial')
 await push('partial',{kind:'ready',prs:[entry(42,'bound')],incomplete:true})
 await resolve(0,ready(entry(41),entry(42,'bound')))
 expect(result!.nav.entries.map(e=>e.summary.number)).toEqual([41,42])
 expect(result!.activeOrigin).toBe('branch')
})
test('transport reconnect recreates the dropped subscription before Refresh',async()=>{
 await mount('reconnect');await resolve(0,ready(entry(51)))
 // This models cleanupRpcClientResources/dropClient on the server's close callback.
 active.clear()
 await act(async()=>{for(const cb of reconnected)cb(false)})
 expect(requests.length).toBe(2)
 await resolve(1, ready(entry(52)))
 expect(result!.state.kind === 'pr' && result!.state.summary.number).toBe(52)
 await act(async()=>{result!.refresh();await Promise.resolve()})
 expect(requests.length).toBe(2)
 expect(active.size).toBe(1)
})

test('a fresh bound push cannot demote the completed branch entry for the same PR', async () => {
  await mount('deduplicate')
  const bound = entry(61, 'bound')
  bound.summary.fetchedAt = 100
  const branch = entry(61)
  branch.summary.fetchedAt = 50
  branch.summary.localAhead = 2
  await push('deduplicate', { kind: 'ready', prs: [bound], incomplete: true })
  await resolve(0, ready(branch))
  expect(result!.activeOrigin).toBe('branch')
  expect(result!.state.kind === 'pr' && result!.state.summary.localAhead).toBe(2)
})
test('the completed set retains newer compatible updates from a partial push', async () => {
  await mount('merge-newer')
  const newer = entry(72, 'bound')
  newer.summary.fetchedAt = 100
  newer.summary.checks = 'failure'
  await push('merge-newer', { kind: 'ready', prs: [newer], incomplete: true })
  await resolve(0, ready(entry(71), entry(72, 'bound')))
  expect(result!.nav.entries.map(e => e.summary.number)).toEqual([71, 72])
  expect(result!.nav.entries[1]!.summary.checks).toBe('failure')
})

test('a newer partial branch push replaces the old branch from the subscribe snapshot', async () => {
  await mount('branch-moved')
  await push('branch-moved', { kind: 'ready', prs: [entry(82), entry(83, 'bound')], incomplete: true })
  await resolve(0, ready(entry(81), entry(83, 'bound')))
  expect(result!.nav.entries.map(e => e.summary.number)).toEqual([82, 83])
  expect(result!.state.kind === 'pr' && result!.state.summary.number).toBe(82)
})

test('reads GitHub again after subscribing, on return, and when the window regains focus', async () => {
  await mount('focus-refresh')
  await resolve(0, ready(entry(91)))
  expect(refreshes).toBe(1)
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  expect(refreshes).toBe(2)
  await update('focus-other')
  await resolve(1, ready(entry(92)))
  await update('focus-refresh')
  await resolve(2, ready(entry(91)))
  expect(refreshes).toBe(4)
  expect(automaticRefreshes).toEqual([true, true, true, true])
})

test('a stale push cannot reopen a merged PR but a different PR remains allowed', async () => {
  await mount('merged-guard')
  const merged = entry(101)
  merged.summary.state = 'merged'
  await resolve(0, ready(merged))
  await push('merged-guard', ready(entry(101)))
  expect(result!.state.kind === 'pr' && result!.state.summary.state).toBe('merged')
  await push('merged-guard', ready(entry(102)))
  expect(result!.state.kind === 'pr' && result!.state.summary.number).toBe(102)
  expect(result!.state.kind === 'pr' && result!.state.summary.state).toBe('open')
})

test('keeps the known PR visible and stale when GitHub fails temporarily', async () => {
  await mount('github-error')
  await resolve(0, ready(entry(6173)))
  await push('github-error', { kind: 'unavailable', reason: 'error' })
  expect(result!.state.kind).toBe('pr')
  expect(result!.state.kind === 'pr' && result!.state.summary.number).toBe(6173)
  expect(result!.state.kind === 'pr' && result!.state.summary.attentionStale).toBe(true)
})

test('sidebar subscriptions stay in the background and never force a refresh on window focus', async () => {
  await mount('sidebar', '/repo', false)
  await resolve(0, ready(entry(111)))
  expect(requests[0]!.foreground).toBe(false)
  expect(refreshes).toBe(0)
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  expect(refreshes).toBe(0)
})

test('opening the chat reconciles automatically without bypassing quota or backoff', async () => {
  await mount('foreground-paused')
  await resolve(0, ready(entry(112)))
  expect(requests[0]!.foreground).toBe(true)
  expect(automaticRefreshes).toEqual([true])
  const merged = entry(112)
  merged.summary.state = 'merged'
  await push('foreground-paused', ready(merged))
  expect(result!.state.kind === 'pr' && result!.state.summary.state).toBe('merged')
  expect(nextPrQuickAction(result!.state, result!.activeOrigin)).toBe('archive')
})

test('twenty sidebar rows and one open chat trigger only one foreground reconciliation', async () => {
  await act(async () => {
    root = create(React.createElement(React.Fragment, null,
      ...Array.from({ length: 20 }, (_, i) => React.createElement(Probe, { key: i, session: `background-${i}`, foreground: false })),
      React.createElement(Probe, { key: 'opened', session: 'opened' }),
    ))
  })
  expect(requests.filter(r => r.foreground === false)).toHaveLength(20)
  expect(requests.filter(r => r.foreground === true)).toHaveLength(1)
  await act(async () => {
    requests.forEach((request, i) => request.result.resolve({ subscriptionId: `sub-${i}`, state: ready(entry(i + 120)) }))
    await Promise.resolve()
  })
  expect(refreshes).toBe(1)
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  expect(refreshes).toBe(2)
})
