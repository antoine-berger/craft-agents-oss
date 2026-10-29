import { afterEach, expect, it } from 'bun:test'
import * as React from 'react'
import Renderer, { act } from 'react-test-renderer'
import { useChatReadingPosition, useChatTurnWindow } from '../useChatReadingPosition'
import { rememberChatReadingPosition } from '../../components/app-shell/chat-display/chat-scroll-position'

let tree: Renderer.ReactTestRenderer | undefined
const originalRaf = globalThis.requestAnimationFrame
const originalCancel = globalThis.cancelAnimationFrame
const originalResize = globalThis.ResizeObserver
const frames = new Map<number, FrameRequestCallback>()
let frameId = 0
function flush() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn(0)) }
afterEach(async () => {
  await act(async () => tree?.unmount())
  tree = undefined
  frames.clear()
  globalThis.requestAnimationFrame = originalRaf
  globalThis.cancelAnimationFrame = originalCancel
  globalThis.ResizeObserver = originalResize
})

it('keeps the first revealed turn through append, insertion and prepend while reading', async () => {
  const stick = { current: false }
  let current!: ReturnType<typeof useChatTurnWindow>
  function Harness({ keys }: { keys: string[] }) { current = useChatTurnWindow('window-reading', true, keys, stick); return null }
  let keys = Array.from({ length: 70 }, (_, i) => `turn-${i}`)
  await act(async () => { tree = Renderer.create(React.createElement(Harness, { keys })) })
  expect(current.visibleTurnCount).toBe(20)
  keys = [...keys, 'new-1', 'new-2', 'new-3', 'new-4']
  await act(async () => { tree!.update(React.createElement(Harness, { keys })) })
  expect(current.visibleTurnCount).toBe(24)
  expect(keys[keys.length - current.visibleTurnCount]).toBe('turn-50')
  keys = ['older-1', ...keys.slice(0, 55), 'inserted', ...keys.slice(55)]
  await act(async () => { tree!.update(React.createElement(Harness, { keys })) })
  expect(current.visibleTurnCount).toBe(25)
  expect(keys[keys.length - current.visibleTurnCount]).toBe('turn-50')
  await act(async () => { current.setVisibleTurnCount(count => count + 20) })
  expect(current.visibleTurnCount).toBe(45)
  const firstRevealed = keys[keys.length - current.visibleTurnCount]
  keys = [...keys, 'new-5']
  await act(async () => { tree!.update(React.createElement(Harness, { keys })) })
  expect(current.visibleTurnCount).toBe(46)
  expect(keys[keys.length - current.visibleTurnCount]).toBe(firstRevealed)
})

it('keeps the last-page behavior at bottom and on the default embedded appearance', async () => {
  const stick = { current: true }
  let current!: ReturnType<typeof useChatTurnWindow>
  function Harness({ keys, enabled }: { keys: string[]; enabled: boolean }) { current = useChatTurnWindow('window-bottom', enabled, keys, stick); return null }
  const keys = Array.from({ length: 70 }, (_, i) => `turn-${i}`)
  await act(async () => { tree = Renderer.create(React.createElement(Harness, { keys, enabled: true })) })
  await act(async () => { tree!.update(React.createElement(Harness, { keys: [...keys, 'new'], enabled: true })) })
  expect(current.visibleTurnCount).toBe(20)
  stick.current = false
  await act(async () => { tree!.update(React.createElement(Harness, { keys: [...keys, 'new', 'new-2'], enabled: false })) })
  expect(current.visibleTurnCount).toBe(20)
})

it('restores each chat window without interpreting a session switch as appended history', async () => {
  rememberChatReadingPosition('window-chat-b', { atBottom: false, scrollTop: 800, visibleTurnCount: 60 })
  const stick = { current: false }
  const keys = Array.from({ length: 70 }, (_, i) => `turn-${i}`)
  let current!: ReturnType<typeof useChatTurnWindow>
  function Harness({ chat }: { chat: string }) { current = useChatTurnWindow(chat, true, keys, stick); return null }
  await act(async () => { tree = Renderer.create(React.createElement(Harness, { chat: 'window-chat-a' })) })
  expect(current.visibleTurnCount).toBe(20)
  await act(async () => { tree!.update(React.createElement(Harness, { chat: 'window-chat-b' })) })
  expect(current.visibleTurnCount).toBe(60)
  await act(async () => { tree!.update(React.createElement(Harness, { chat: 'window-chat-a' })) })
  expect(current.visibleTurnCount).toBe(20)
})

it('reveals a saved reading anchor after new turns arrived while its chat was closed', async () => {
  rememberChatReadingPosition('window-returning', { atBottom: false, scrollTop: 500, visibleTurnCount: 20, anchor: { key: 'turn-53', offset: 100 } })
  const stick = { current: true }
  const keys = Array.from({ length: 170 }, (_, i) => `turn-${i}`)
  let current!: ReturnType<typeof useChatTurnWindow>
  function Harness() { current = useChatTurnWindow('window-returning', true, keys, stick); return null }
  await act(async () => { tree = Renderer.create(React.createElement(Harness)) })
  expect(current.visibleTurnCount).toBe(117)
  expect(keys.slice(-current.visibleTurnCount)).toContain('turn-53')
})

it('includes the saved anchor when history loads after the returning chat mounts', async () => {
  rememberChatReadingPosition('window-lazy-returning', { atBottom: false, scrollTop: 500, visibleTurnCount: 20, anchor: { key: 'turn-53', offset: 100 } })
  const stick = { current: true }
  let current!: ReturnType<typeof useChatTurnWindow>
  function Harness({ keys }: { keys: string[] }) { current = useChatTurnWindow('window-lazy-returning', true, keys, stick); return null }
  await act(async () => { tree = Renderer.create(React.createElement(Harness, { keys: [] })) })
  expect(current.visibleTurnCount).toBe(20)
  await act(async () => { tree!.update(React.createElement(Harness, { keys: Array.from({ length: 170 }, (_, i) => `turn-${i}`) })) })
  expect(current.visibleTurnCount).toBe(117)
})

it('cancels deferred navigation on user interaction, supersession, session switch and unmount', async () => {
  globalThis.requestAnimationFrame = fn => { const id = ++frameId; frames.set(id, fn); return id }
  globalThis.cancelAnimationFrame = id => { frames.delete(id) }
  globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver
  const events = new EventTarget()
  const calls: Array<{ top: number; behavior?: string }> = []
  const viewport = { scrollTop: 1000, scrollHeight: 3000, clientHeight: 400, firstElementChild: null, style: { overflowAnchor: '' }, getBoundingClientRect: () => ({ top: 0 }), addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), scrollTo(options: { top: number; behavior?: string }) { calls.push(options); this.scrollTop = options.top } }
  const turn = { getBoundingClientRect: () => ({ top: 200 - viewport.scrollTop, bottom: 300 - viewport.scrollTop, height: 100 }) }
  const viewportRef = { current: viewport as unknown as HTMLDivElement }
  const turnsRef = { current: new Map([['older', turn as unknown as HTMLDivElement]]) }
  const stick = { current: false }
  let hook!: ReturnType<typeof useChatReadingPosition>
  function Harness({ chat }: { chat: string }) { hook = useChatReadingPosition({ key: chat, enabled: true, ready: true, searching: false, visibleTurnCount: 60, viewportRef, turnsRef, stickToBottomRef: stick }); return null }
  await act(async () => { tree = Renderer.create(React.createElement(Harness, { chat: 'deferred-nav-a' })) })
  await act(async () => { flush() })
  calls.length = 0
  const isCurrent = hook.beginNavigation()
  requestAnimationFrame(() => { if (isCurrent()) hook.navigateToTurn('older') })
  await act(async () => { events.dispatchEvent(new Event('pointerdown')); flush() })
  expect(calls).toHaveLength(1)
  expect(calls[0]?.behavior).toBe('instant')
  const stale = hook.beginNavigation()
  const newest = hook.beginNavigation()
  expect(stale()).toBe(false)
  expect(newest()).toBe(true)
  await act(async () => { tree!.update(React.createElement(Harness, { chat: 'deferred-nav-b' })) })
  expect(newest()).toBe(false)
  const beforeUnmount = hook.beginNavigation()
  await act(async () => tree!.unmount())
  tree = undefined
  expect(beforeUnmount()).toBe(false)
})
