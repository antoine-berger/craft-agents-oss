import { afterAll, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'

const passthrough = ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children)
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
mock.module('../ui/popover', () => ({ Popover: passthrough, PopoverContent: passthrough, PopoverTrigger: passthrough }))
mock.module('../ui/drawer', () => ({ Drawer: passthrough, DrawerContent: passthrough, DrawerHeader: passthrough, DrawerTitle: passthrough, DrawerTrigger: passthrough }))
mock.module('../ui/dialog', () => ({ Dialog: passthrough, DialogContent: passthrough, DialogHeader: passthrough, DialogTitle: passthrough }))
mock.module('../ui/input', () => ({ Input: (props: object) => React.createElement('input', props) }))
mock.module('../ui/button', () => ({ Button: (props: object) => React.createElement('button', props) }))
mock.module('../right-sidebar/SessionFilesSection', () => ({ SessionFilesSection: () => null }))
mock.module('../worktree-stack/WorktreeStackSection', () => ({ WorktreeStackSection: () => null }))
mock.module('./ShipUsageSection', () => ({ ShipUsageSection: () => null }))
mock.module('../../lib/navigate', () => ({ navigate: () => {}, routes: {} }))
mock.module('../../lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }))

let owned: { adopted: true; path: string } | undefined
mock.module('../../context/AppShellContext', () => ({
  useSession: () => ({ id: 'imported', name: 'Imported', importedFrom: 'conductor', workingDirectory: '/repo/worktree', worktree: { owned } }),
  useAppShellContext: () => ({ onRenameSession: () => {} }),
}))
const originalWindow = globalThis.window
const reason = 'Submodules are not supported'
const readiness = { supported: false, reason, checkpoints: [] }
let listCalls = 0
Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {
  adoptSessionCheckpointWorktree: async () => readiness,
  listSessionCheckpoints: async () => { listCalls++; return readiness },
} } })
afterAll(() => { Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow }) })
const { SessionInfoPopover } = await import('./SessionInfoPopover')
const element = () => React.createElement(SessionInfoPopover, { sessionId: 'imported', open: true, presentation: 'dialog' })
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

test('unsupported checkpoint reason survives association, owned metadata updates and reopening', async () => {
  owned = undefined
  listCalls = 0
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(element()); await tick() })
  const button = renderer.root.findAllByType('button').find(node => node.children.includes('Enable future checkpoints'))!
  expect(button).toBeDefined()
  await act(async () => { button.props.onClick(); await tick() })
  expect(renderer.root.findByProps({ role: 'status' }).children.join('')).toBe(`Checkpoints unavailable: ${reason}`)
  expect(renderer.root.findAllByType('button')).toHaveLength(0)

  owned = { adopted: true, path: '/repo/worktree' }
  await act(async () => { renderer.update(element()); await tick() })
  expect(renderer.root.findByProps({ role: 'status' }).children.join('')).toContain(reason)
  expect(listCalls).toBe(1)
  act(() => renderer.unmount())

  await act(async () => { renderer = create(element()); await tick() })
  expect(renderer.root.findByProps({ role: 'status' }).children.join('')).toContain(reason)
  expect(renderer.root.findAllByType('button')).toHaveLength(0)
  expect(listCalls).toBe(2)
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Checkpoints enabled')
  act(() => renderer.unmount())
})
