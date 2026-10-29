import { describe, expect, it } from 'bun:test'
import { getComposerMaxHeight } from '../composer-height'

describe('chat composer budget', () => {
  it('keeps a long draft bounded while reserving its action row', () => {
    expect(getComposerMaxHeight(1000, 'freeform', 'chat')).toBe(250)
    expect(getComposerMaxHeight(Number.NaN, 'freeform', 'chat')).toBe(250)
    expect(getComposerMaxHeight(190, 'freeform', 'chat')).toBe(190)
  })
  it('never grows beyond a constrained viewport', () => {
    expect(getComposerMaxHeight(80, 'freeform', 'chat')).toBe(80)
    expect(getComposerMaxHeight(0, 'freeform', 'chat')).toBe(0)
    expect(getComposerMaxHeight(-10, 'freeform', 'chat')).toBe(0)
  })
  it('preserves embedded editors and structured prompts', () => {
    expect(getComposerMaxHeight(1000, 'freeform')).toBe(584)
    expect(getComposerMaxHeight(600, 'freeform')).toBe(396)
    expect(getComposerMaxHeight(600, 'structured', 'chat')).toBe(getComposerMaxHeight(600, 'structured'))
  })
})
