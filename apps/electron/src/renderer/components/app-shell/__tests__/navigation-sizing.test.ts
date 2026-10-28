import { expect, test } from 'bun:test'
import { fitNavigationWidths, MIN_DESKTOP_SHELL_WIDTH } from '../navigation-sizing'

const saved = { shellWidth: 1280, sidebarWidth: 320, listWidth: 480, sidebarVisible: true, navigatorVisible: true, contentVisible: true }
test('wide layouts preserve saved widths and do not mutate preferences', () => {
  expect(fitNavigationWidths(saved)).toEqual({ sidebar: 320, list: 480 })
  expect(saved.listWidth).toBe(480)
})
test('narrow desktop reserves a usable conversation and restores saved widths when widened', () => {
  expect(fitNavigationWidths({ ...saved, shellWidth: MIN_DESKTOP_SHELL_WIDTH })).toEqual({ sidebar: 180, list: 240 })
  expect(fitNavigationWidths(saved)).toEqual({ sidebar: 320, list: 480 })
})
test('hidden sidebars and absent navigators do not consume the conversation budget', () => {
  expect(fitNavigationWidths({ ...saved, shellWidth: 1000, sidebarVisible: false })).toEqual({ sidebar: 320, list: 480 })
  expect(fitNavigationWidths({ ...saved, shellWidth: 1000, navigatorVisible: false })).toEqual({ sidebar: 320, list: 480 })
})
test('no selected content retains the requested navigation widths', () => {
  expect(fitNavigationWidths({ ...saved, shellWidth: 900, contentVisible: false })).toEqual({ sidebar: 320, list: 480 })
})
test('malformed stored widths fall back safely', () => {
  expect(fitNavigationWidths({ ...saved, sidebarWidth: NaN, listWidth: Infinity })).toEqual({ sidebar: 216, list: 280 })
})
