export const NAVIGATION_WIDTHS = {
  sidebar: { default: 216, min: 180, max: 320 },
  list: { default: 280, min: 240, max: 480 },
  contentMin: 440,
  chrome: 18,
} as const

export const MIN_DESKTOP_SHELL_WIDTH = NAVIGATION_WIDTHS.sidebar.min + NAVIGATION_WIDTHS.list.min
  + NAVIGATION_WIDTHS.contentMin + NAVIGATION_WIDTHS.chrome

export function fitNavigationWidths(input: {
  shellWidth: number
  sidebarWidth: number
  listWidth: number
  sidebarVisible: boolean
  navigatorVisible: boolean
  contentVisible: boolean
}): { sidebar: number; list: number } {
  const sidebar = NAVIGATION_WIDTHS.sidebar, list = NAVIGATION_WIDTHS.list
  const finite = (width: number, fallback: number) => Number.isFinite(width) ? width : fallback
  const result = {
    sidebar: Math.min(sidebar.max, Math.max(sidebar.min, finite(input.sidebarWidth, sidebar.default))),
    list: Math.min(list.max, Math.max(list.min, finite(input.listWidth, list.default))),
  }
  if (!input.contentVisible || input.shellWidth <= 0) return result
  const available = input.shellWidth - NAVIGATION_WIDTHS.chrome - NAVIGATION_WIDTHS.contentMin
  let excess = (input.sidebarVisible ? result.sidebar : 0) + (input.navigatorVisible ? result.list : 0) - available
  if (excess <= 0) return result
  if (input.navigatorVisible) {
    const reduction = Math.min(excess, result.list - list.min)
    result.list -= reduction; excess -= reduction
  }
  if (input.sidebarVisible && excess > 0) result.sidebar -= Math.min(excess, result.sidebar - sidebar.min)
  return result
}
