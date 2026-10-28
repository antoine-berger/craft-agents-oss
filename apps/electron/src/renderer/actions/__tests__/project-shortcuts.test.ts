import { describe, expect, it } from 'bun:test'
import { actions } from '../definitions'
import { matchesHotkey } from '../registry'
import { isMac } from '@/lib/platform'

function key(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key: '1', code: 'Digit1', metaKey: isMac, ctrlKey: !isMac, shiftKey: false, altKey: false, ...overrides } as KeyboardEvent
}

describe('project keyboard shortcuts', () => {
  it('assigns each digit exclusively to its project and keeps pane focus separate', () => {
    for (let n = 1; n <= 9; n++) {
      const matchingActions: string[] = Object.values(actions).filter(a => a.defaultHotkey === `mod+${n}`).map(a => a.id)
      expect(matchingActions).toEqual([`project.open${n}`])
    }
    expect(actions['nav.focusSidebar'].defaultHotkey).toBe('mod+alt+1')
    expect(actions['nav.focusNavigator'].defaultHotkey).toBe('mod+alt+2')
    expect(actions['nav.focusChat'].defaultHotkey).toBe('mod+alt+3')
  })

  it('supports the number row on AZERTY and does not confuse project and pane shortcuts', () => {
    expect(matchesHotkey(key({ key: '&' }), 'mod+1')).toBe(true)
    expect(matchesHotkey(key({ key: '¡', altKey: true }), 'mod+alt+1')).toBe(true)
    expect(matchesHotkey(key({ altKey: true }), 'mod+1')).toBe(false)
    expect(matchesHotkey(key({ shiftKey: true }), 'mod+1')).toBe(false)
    expect(matchesHotkey(key({ metaKey: false, ctrlKey: false }), 'mod+1')).toBe(false)
  })

  it('continues to match letters logically rather than by physical key position', () => {
    const azertyA = key({ key: 'a', code: 'KeyQ' })
    expect(matchesHotkey(azertyA, 'mod+a')).toBe(true)
    expect(matchesHotkey(azertyA, 'mod+q')).toBe(false)
  })
})
