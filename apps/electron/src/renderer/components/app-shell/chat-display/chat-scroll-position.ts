export interface ChatReadingPosition {
  atBottom: boolean
  scrollTop: number
  visibleTurnCount: number
  anchor?: { key: string; offset: number }
}

interface ScrollViewport {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  getBoundingClientRect(): { top: number }
}
interface TurnElement {
  getBoundingClientRect(): { top: number; bottom: number }
}

// Like Conductor's reading positions, these live for the client lifetime, not in chat history.
const positions = new Map<string, ChatReadingPosition>()
export const CHAT_TURNS_PER_PAGE = 20

export function getChatReadingPosition(key: string | null): ChatReadingPosition | undefined {
  return key ? positions.get(key) : undefined
}

export function rememberChatReadingPosition(key: string, position: ChatReadingPosition): void {
  positions.set(key, { ...position, anchor: position.anchor && { ...position.anchor } })
}

export function chatDistanceFromBottom(viewport: ScrollViewport): number {
  return Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop)
}

/** Keep the turn crossing the viewport's middle still when earlier content changes height. */
export function readChatPosition(
  viewport: ScrollViewport,
  turns: ReadonlyMap<string, TurnElement>,
  visibleTurnCount: number,
  atBottom = chatDistanceFromBottom(viewport) < 20,
): ChatReadingPosition {
  const top = viewport.getBoundingClientRect().top
  const middle = top + viewport.clientHeight / 2
  let anchor: ChatReadingPosition['anchor']
  let nearestDistance = Infinity
  for (const [key, element] of turns) {
    const rect = element.getBoundingClientRect()
    if (rect.bottom <= top || rect.top >= top + viewport.clientHeight) continue
    const distance = rect.top <= middle && rect.bottom > middle ? 0 : Math.min(Math.abs(rect.top - middle), Math.abs(rect.bottom - middle))
    if (distance < nearestDistance) {
      anchor = { key, offset: rect.top - top }
      nearestDistance = distance
    }
  }
  return { atBottom, scrollTop: viewport.scrollTop, visibleTurnCount, anchor }
}

export function lastVisibleChatTurn(viewport: ScrollViewport, turns: ReadonlyMap<string, TurnElement>): string | undefined {
  const top = viewport.getBoundingClientRect().top
  let active: string | undefined
  let lastTop = -Infinity
  for (const [key, element] of turns) {
    const rect = element.getBoundingClientRect()
    if (rect.bottom > top && rect.top < top + viewport.clientHeight && rect.top > lastTop) {
      active = key
      lastTop = rect.top
    }
  }
  return active
}

/** Missing/deleted anchors fall back to the last offset; they never force a jump to the end. */
export function restoreChatPosition(
  viewport: ScrollViewport,
  turns: ReadonlyMap<string, TurnElement>,
  position: ChatReadingPosition,
): void {
  let target = position.scrollTop
  if (position.atBottom) {
    target = viewport.scrollHeight - viewport.clientHeight
  } else if (position.anchor) {
    const anchor = turns.get(position.anchor.key)
    if (anchor) target = viewport.scrollTop + anchor.getBoundingClientRect().top
      - viewport.getBoundingClientRect().top - position.anchor.offset
  }
  viewport.scrollTop = Math.max(0, Math.min(target, viewport.scrollHeight - viewport.clientHeight))
}
