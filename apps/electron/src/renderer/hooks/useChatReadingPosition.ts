import * as React from 'react'
import {
  CHAT_TURNS_PER_PAGE,
  chatDistanceFromBottom,
  getChatReadingPosition,
  readChatPosition,
  lastVisibleChatTurn,
  rememberChatReadingPosition,
  restoreChatPosition,
  type ChatReadingPosition,
} from '../components/app-shell/chat-display/chat-scroll-position'

export function useChatTurnWindow(key: string | null, enabled: boolean, turnKeys: readonly string[], stickToBottomRef: React.MutableRefObject<boolean>) {
  const savedPosition = enabled ? getChatReadingPosition(key) : undefined
  const savedAnchorIndex = savedPosition?.anchor && !savedPosition.atBottom ? turnKeys.indexOf(savedPosition.anchor.key) : -1
  const initialCount = Math.max(savedPosition?.visibleTurnCount ?? CHAT_TURNS_PER_PAGE, savedAnchorIndex >= 0 ? turnKeys.length - savedAnchorIndex : 0)
  const currentTurnKeys = React.useRef(turnKeys)
  currentTurnKeys.current = turnKeys
  const [window, setWindow] = React.useState({ key, count: initialCount, firstTurnKey: turnKeys[Math.max(0, turnKeys.length - initialCount)] })
  let visibleTurnCount = window.key === key ? window.count : initialCount
  if (!window.firstTurnKey) visibleTurnCount = Math.max(visibleTurnCount, initialCount)
  if (enabled && window.key === key && !stickToBottomRef.current && window.firstTurnKey) {
    const firstIndex = turnKeys.indexOf(window.firstTurnKey)
    if (firstIndex >= 0) visibleTurnCount = Math.max(visibleTurnCount, turnKeys.length - firstIndex)
  }
  const firstTurnKey = turnKeys[Math.max(0, turnKeys.length - visibleTurnCount)]
  // Adjust before commit so an append never unmounts the turn being read.
  if (window.key !== key || window.count !== visibleTurnCount || window.firstTurnKey !== firstTurnKey) {
    setWindow({ key, count: visibleTurnCount, firstTurnKey })
  }
  const setVisibleTurnCount = React.useCallback<React.Dispatch<React.SetStateAction<number>>>(update => {
    setWindow(previous => {
      const previousCount = previous.key === key ? previous.count : initialCount
      const count = typeof update === 'function' ? update(previousCount) : update
      const keys = currentTurnKeys.current
      return { key, count, firstTurnKey: keys[Math.max(0, keys.length - count)] }
    })
  }, [key, initialCount])
  return { visibleTurnCount, setVisibleTurnCount }
}

interface Options {
  key: string | null
  enabled: boolean
  ready: boolean
  searching: boolean
  visibleTurnCount: number
  viewportRef: React.RefObject<HTMLDivElement | null>
  turnsRef: React.MutableRefObject<Map<string, HTMLDivElement>>
  stickToBottomRef: React.MutableRefObject<boolean>
}

/** Reading position belongs to a chat, even when another panel receives focus. */
export function useChatReadingPosition({ key, enabled, ready, searching, visibleTurnCount, viewportRef, turnsRef, stickToBottomRef }: Options) {
  const activeKeyRef = React.useRef(key)
  activeKeyRef.current = key
  const record = React.useMemo(() => ({
    position: getChatReadingPosition(key),
    pendingTarget: undefined as { top?: number; bottom?: boolean } | undefined,
    restoring: false,
    navigationVersion: 0,
  }), [key])
  const countRef = React.useRef(visibleTurnCount)
  const [view, setView] = React.useState<{ key: string | null; active?: string; bottomDistance: number }>({ key, bottomDistance: 0 })
  const viewForChat = view.key === key ? view : { key, bottomDistance: 0, active: record.position?.anchor?.key }

  const capture = React.useCallback(() => {
    const viewport = viewportRef.current
    if (!enabled || !ready || !key || !viewport) return
    record.position = readChatPosition(viewport, turnsRef.current, countRef.current, stickToBottomRef.current)
    rememberChatReadingPosition(key, record.position)
    const active = lastVisibleChatTurn(viewport, turnsRef.current)
    const bottomDistance = chatDistanceFromBottom(viewport)
    setView(previous => previous.key === key && previous.active === active && (previous.bottomDistance > 400) === (bottomDistance > 400)
      ? previous : { key, active, bottomDistance })
  }, [enabled, ready, key, record, viewportRef, turnsRef, stickToBottomRef])

  const scrollToEnd = React.useCallback((behavior: ScrollBehavior = 'smooth') => {
    const viewport = viewportRef.current
    if (!viewport || activeKeyRef.current !== key) return
    stickToBottomRef.current = true
    const top = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    record.pendingTarget = Math.abs(viewport.scrollTop - top) > 2 ? { bottom: true } : undefined
    viewport.scrollTo({ top, behavior })
    capture()
  }, [key, viewportRef, stickToBottomRef, record, capture])

  // Reveal callbacks must also be cancellable before their first scroll starts.
  const beginNavigation = React.useCallback(() => {
    const version = ++record.navigationVersion
    return () => activeKeyRef.current === key && record.navigationVersion === version
  }, [key, record])

  const navigateToTurn = React.useCallback((turnKey: string, behavior: ScrollBehavior = 'smooth', align: 'start' | 'center' = 'start') => {
    const viewport = viewportRef.current
    const turn = turnsRef.current.get(turnKey)
    if (!viewport || !turn || activeKeyRef.current !== key) return false
    stickToBottomRef.current = false
    const rect = turn.getBoundingClientRect()
    const inset = align === 'center' ? (viewport.clientHeight - rect.height) / 2 : 16
    const target = viewport.scrollTop + rect.top - viewport.getBoundingClientRect().top - inset
    const top = Math.max(0, Math.min(target, viewport.scrollHeight - viewport.clientHeight))
    record.pendingTarget = Math.abs(viewport.scrollTop - top) > 2 ? { top } : undefined
    viewport.scrollTo({ top, behavior })
    capture()
    return true
  }, [key, viewportRef, turnsRef, stickToBottomRef, record, capture])

  React.useLayoutEffect(() => {
    countRef.current = visibleTurnCount
    if (record.position) record.position.visibleTurnCount = visibleTurnCount
  }, [record, visibleTurnCount])

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!enabled || !ready || !key || !viewport) return
    let frame = 0
    let disposed = false
    const originalOverflowAnchor = viewport.style.overflowAnchor
    viewport.style.overflowAnchor = 'none'
    record.restoring = true
    stickToBottomRef.current = searching ? false : record.position?.atBottom ?? true
    if (!searching) restoreChatPosition(viewport, turnsRef.current, record.position ?? {
      atBottom: true, scrollTop: 0, visibleTurnCount: countRef.current,
    })
    capture()
    frame = requestAnimationFrame(() => { record.restoring = false })

    const onScroll = () => {
      const distance = chatDistanceFromBottom(viewport)
      if (record.pendingTarget?.bottom && distance < 2) record.pendingTarget = undefined
      if (record.pendingTarget?.top !== undefined && Math.abs(viewport.scrollTop - record.pendingTarget.top) < 2) record.pendingTarget = undefined
      if (!record.pendingTarget && !record.restoring) stickToBottomRef.current = distance < 20
      capture()
    }
    const cancelNavigation = (event: Event) => {
      const keyboard = event as KeyboardEvent
      if (event.type === 'keydown' && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(keyboard.key)) return
      record.navigationVersion++
      cancelAnimationFrame(frame)
      record.restoring = false
      record.pendingTarget = undefined
      viewport.scrollTo({ top: viewport.scrollTop, behavior: 'instant' })
      if ((event as WheelEvent).deltaY < 0 || ['ArrowUp', 'PageUp', 'Home'].includes(keyboard.key)) stickToBottomRef.current = false
      capture()
    }
    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return
      if (record.pendingTarget?.bottom) {
        viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight
        record.pendingTarget = undefined
      } else if (record.pendingTarget) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (disposed) return
        if (stickToBottomRef.current) {
          viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight
        } else if (record.position) {
          restoreChatPosition(viewport, turnsRef.current, record.position)
        }
        record.restoring = false
        capture()
      })
    })
    viewport.addEventListener('scroll', onScroll, { passive: true })
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) viewport.addEventListener(event, cancelNavigation, { passive: true })
    resizeObserver.observe(viewport)
    if (viewport.firstElementChild) resizeObserver.observe(viewport.firstElementChild)
    return () => {
      disposed = true
      record.navigationVersion++
      cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      viewport.removeEventListener('scroll', onScroll)
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) viewport.removeEventListener(event, cancelNavigation)
      viewport.style.overflowAnchor = originalOverflowAnchor
      if (record.position) rememberChatReadingPosition(key, record.position)
    }
  }, [enabled, ready, key, searching, record, capture, viewportRef, turnsRef, stickToBottomRef])

  const isRestoring = React.useCallback(() => record.restoring || !!record.pendingTarget, [record])
  return {
    activeTurnKey: viewForChat.active,
    showScrollToBottom: viewForChat.bottomDistance > 400,
    scrollToEnd,
    navigateToTurn,
    beginNavigation,
    capture,
    isRestoring,
  }
}
