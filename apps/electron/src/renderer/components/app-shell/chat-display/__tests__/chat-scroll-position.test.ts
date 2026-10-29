import { describe, expect, it } from 'bun:test'
import { chatDistanceFromBottom, lastVisibleChatTurn, getChatReadingPosition, readChatPosition, rememberChatReadingPosition, restoreChatPosition } from '../chat-scroll-position'

function transcript() {
  const viewport = { scrollTop: 900, scrollHeight: 2400, clientHeight: 600, getBoundingClientRect: () => ({ top: 80 }) }
  const offsets = new Map([['before', 600], ['reading', 1100], ['after', 1600]])
  const frames = new Map([...offsets].map(([key]) => [key, { getBoundingClientRect: () => ({ top: 80 + offsets.get(key)! - viewport.scrollTop, bottom: 80 + offsets.get(key)! - viewport.scrollTop + 500 }) }]))
  return { viewport, offsets, frames }
}

describe('chat reading position', () => {
  it('restores the same turn and offset when earlier history is prepended', () => {
    const { viewport, offsets, frames } = transcript()
    const saved = readChatPosition(viewport, frames, 40)
    expect(saved.anchor).toEqual({ key: 'reading', offset: 200 })
    viewport.scrollHeight += 300
    for (const [key, offset] of offsets) offsets.set(key, offset + 300)
    restoreChatPosition(viewport, frames, saved)
    expect(viewport.scrollTop).toBe(1200)
    expect(frames.get('reading')!.getBoundingClientRect().top - viewport.getBoundingClientRect().top).toBe(200)
  })

  it('keeps the reading anchor stable through tool expansion and late image sizing above it', () => {
    const { viewport, offsets, frames } = transcript()
    const saved = readChatPosition(viewport, frames, 40)
    offsets.set('reading', offsets.get('reading')! + 420)
    viewport.scrollHeight += 420
    restoreChatPosition(viewport, frames, saved)
    expect(viewport.scrollTop).toBe(1320)
    offsets.set('reading', offsets.get('reading')! + 90)
    viewport.scrollHeight += 90
    restoreChatPosition(viewport, frames, saved)
    expect(viewport.scrollTop).toBe(1410)
  })

  it('does not follow appended streaming output while reading older content', () => {
    const { viewport, frames } = transcript()
    const saved = readChatPosition(viewport, frames, 20)
    viewport.scrollHeight += 800
    restoreChatPosition(viewport, frames, saved)
    expect(viewport.scrollTop).toBe(900)
    expect(saved.atBottom).toBe(false)
  })

  it('follows the new end only when the reader was already at the bottom', () => {
    const { viewport, frames } = transcript()
    viewport.scrollTop = 1800
    const saved = readChatPosition(viewport, frames, 20)
    viewport.scrollHeight += 800
    restoreChatPosition(viewport, frames, saved)
    expect(viewport.scrollTop).toBe(2600)
    expect(chatDistanceFromBottom(viewport)).toBe(0)
  })

  it('finds the middle visible turn even when newly mounted history enters the ref map last', () => {
    const { viewport, frames } = transcript()
    const reordered = new Map([['after', frames.get('after')!], ['before', frames.get('before')!], ['reading', frames.get('reading')!]])
    expect(readChatPosition(viewport, reordered, 40).anchor?.key).toBe('reading')
  })

  it('highlights the last visible turn in the outline independently of its reading anchor', () => {
    const viewport = { scrollTop: 0, scrollHeight: 1200, clientHeight: 600, getBoundingClientRect: () => ({ top: 0 }) }
    const frames = new Map([['last', 450], ['first', 0], ['middle', 225]].map(([key, top]) => [String(key), { getBoundingClientRect: () => ({ top: Number(top), bottom: Number(top) + 225 }) }]))
    expect(readChatPosition(viewport, frames, 20).anchor?.key).toBe('middle')
    expect(lastVisibleChatTurn(viewport, frames)).toBe('last')
  })

  it('restores a saved offset if a message was removed, rather than jumping to the end', () => {
    const { viewport, frames } = transcript()
    const saved = readChatPosition(viewport, frames, 20)
    frames.delete('reading')
    viewport.scrollTop = 0
    restoreChatPosition(viewport, frames, saved)
    expect(viewport.scrollTop).toBe(900)
  })

  it('clamps a saved offset after a restore truncates history', () => {
    const { viewport, frames } = transcript()
    frames.clear()
    viewport.scrollHeight = 700
    restoreChatPosition(viewport, frames, { atBottom: false, scrollTop: 1500, visibleTurnCount: 60 })
    expect(viewport.scrollTop).toBe(100)
    viewport.scrollHeight = 200
    restoreChatPosition(viewport, frames, { atBottom: false, scrollTop: 1500, visibleTurnCount: 60 })
    expect(viewport.scrollTop).toBe(0)
  })

  it('keeps expanded history and position separate across workspaces and sessions', () => {
    const a = JSON.stringify(['workspace-a', 'chat'])
    const b = JSON.stringify(['workspace-b', 'chat'])
    rememberChatReadingPosition(a, { atBottom: false, scrollTop: 800, visibleTurnCount: 60 })
    rememberChatReadingPosition(b, { atBottom: true, scrollTop: 120, visibleTurnCount: 20 })
    expect(getChatReadingPosition(a)).toEqual({ atBottom: false, scrollTop: 800, visibleTurnCount: 60, anchor: undefined })
    expect(getChatReadingPosition(b)?.visibleTurnCount).toBe(20)
  })

  it('keeps older reading positions and does not mutate their saved snapshots', () => {
    const position = { atBottom: false, scrollTop: 12, visibleTurnCount: 20, anchor: { key: 'reading', offset: 4 } }
    rememberChatReadingPosition('scroll-bounded-0', position)
    position.anchor.offset = 200
    expect(getChatReadingPosition('scroll-bounded-0')?.anchor?.offset).toBe(4)
    for (let i = 1; i <= 100; i++) rememberChatReadingPosition(`scroll-bounded-${i}`, position)
    expect(getChatReadingPosition('scroll-bounded-0')?.anchor?.offset).toBe(4)
    expect(getChatReadingPosition('scroll-bounded-100')).toBeDefined()
  })
})
