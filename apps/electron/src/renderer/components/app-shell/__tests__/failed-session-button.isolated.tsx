import { afterEach, expect, it, mock } from 'bun:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { createStore, Provider } from 'jotai'

const pass = ({ children }: any) => <>{children}</>
mock.module('@craft-agent/ui', () => ({ Tooltip: pass, TooltipTrigger: pass, TooltipContent: pass }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, options: any) => options.defaultValue.replace('{{count}}', String(options.count)) }) }))
const errors: string[] = []
let errorDetails: string | undefined
mock.module('sonner', () => ({ toast: { error: (message: string, options: any) => { errors.push(message); errorDetails = options?.description } } }))
const { FailedSessionsButton } = await import('../FailedSessionsButton')
const { sessionMetaMapAtom } = await import('@/atoms/sessions')
let root: ReturnType<typeof create> | undefined
const originalWindow = globalThis.window
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; globalThis.window = originalWindow; errors.length = 0 })
const failed = (id: string, message = 'Process exited', extra: any = {}) => ({ id, workspaceId: 'workspace', recovery: { status: 'failed', at: 1, message }, ...extra })

it('shows reasons for all visible chats in the workspace, excluding busy and archived chats', async () => {
  const store = createStore()
  const chats = [failed('crash-a', '', { recovery: { status: 'failed', at: 1, reason: 'server_restart' } }),
    failed('crash-b', '', { recovery: { status: 'failed', at: 1, reason: 'server_restart' } }),
    failed('quota', 'Usage limit reached'), failed('auth', 'Authentication failed'),
    failed('archived', '', { isArchived: true }), failed('busy', '', { isProcessing: true }),
    failed('background-busy', '', { backgroundAgentCount: 2 }),
    failed('nested', '', { parentSessionId: 'parent' }), failed('hidden', '', { hidden: true }),
    failed('other', '', { workspaceId: 'other' }), failed('done', '', { recovery: null })]
  store.set(sessionMetaMapAtom, new Map(chats.map(chat => [chat.id, chat])) as any)
  const sent: string[] = [], release: Array<() => void> = []
  globalThis.window = { electronAPI: { sessionCommand: (id: string, command: any) => {
    expect(command).toEqual({ type: 'resumeFailed' }); sent.push(id)
    return new Promise<void>(resolve => release.push(resolve))
  } } } as any
  await act(async () => { root = create(<Provider store={store}><FailedSessionsButton workspaceId="workspace" /></Provider>) })
  const button = root!.root.findByType('button')
  expect(button.props['aria-label']).toBe('Resume interrupted chats (5)')
  const rows = root!.root.findAllByType('dt').map((label, index) => [label.props.children, root!.root.findAllByType('dd')[index]!.props.children])
  expect(rows).toEqual([['Server interrupted', 2], ['Usage limit reached', 1], ['Authentication required', 1], ['Agent or command interrupted', 1]])
  let first!: Promise<void>, second!: Promise<void>
  await act(async () => { first = button.props.onClick(); second = button.props.onClick() })
  expect(sent).toEqual(['crash-a', 'crash-b', 'quota', 'auth', 'nested']) // All dispatched before any ACK.
  expect(root!.root.findByType('button').props.disabled).toBe(true)
  await act(async () => { release.forEach(resolve => resolve()); await Promise.all([first, second]) })
  expect(root!.root.findByType('button').props.disabled).toBe(false)
})

it('reports failed acknowledgements and allows another owner retry', async () => {
  const store = createStore()
  store.set(sessionMetaMapAtom, new Map([['chat', failed('chat')]]) as any)
  let calls = 0
  globalThis.window = { electronAPI: { sessionCommand: async () => { calls++; throw new Error('offline') } } } as any
  await act(async () => { root = create(<Provider store={store}><FailedSessionsButton workspaceId="workspace" /></Provider>) })
  await act(async () => root!.root.findByType('button').props.onClick())
  expect(errors).toEqual(['Could not resume 1 chats.'])
  expect(errorDetails).toBe('chat: offline')
  await act(async () => root!.root.findByType('button').props.onClick())
  expect(calls).toBe(2)
})

it('hides the button when there is nothing to resume', async () => {
  await act(async () => { root = create(<Provider store={createStore()}><FailedSessionsButton workspaceId="workspace" /></Provider>) })
  expect(root!.toJSON()).toBeNull()
})
