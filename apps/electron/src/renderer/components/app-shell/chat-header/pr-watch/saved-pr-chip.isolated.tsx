import { expect, mock, test } from 'bun:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { savedPrSummary } from '../../../../../../../../packages/server-core/src/services/pr-watch/association-store'

const opened: string[] = []
mock.module('@/context/AppShellContext', () => ({ useAppShellContext: () => ({ onOpenUrl: (url: string) => opened.push(url) }) }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
mock.module('@craft-agent/ui', () => ({ Spinner: () => null }))
mock.module('@/components/ui/styled-dropdown', () => ({ DropdownMenu: () => null, DropdownMenuTrigger: () => null,
  StyledDropdownMenuContent: () => null, StyledDropdownMenuItem: () => null }))
const { ChatHeaderPrChip } = await import('./ChatHeaderPrChip')
const { PrQuickActions } = await import('./PrQuickActions')

test('merge queue button does not depend on whether the chat agent is processing', () => {
  const summary: any = { number: 7, state: 'open', headOid: 'abc', headMatchesLocal: true,
    localDirty: false, localAhead: 0, checks: 'success', reviewDecision: 'approved',
    mergeState: 'clean', unresolvedThreads: 0, quickActions: { canMerge: true, mergeQueue: true } }
  let view: ReturnType<typeof create>
  // No useSession hook is provided: GitHub actions must not subscribe to chat processing state.
  act(() => { view = create(React.createElement(PrQuickActions, { sessionId: 's1', origin: 'branch', state: { kind: 'pr', summary } })) })
  const button = view!.root.findByType('button')
  expect(button.props.disabled).toBe(false)
  expect(button.children).toContain('Add to queue')
  act(() => view!.unmount())
})

test('reopened UI keeps the saved PR button and link without claiming fresh green checks', () => {
  const summary = savedPrSummary({ coords: { host: 'github.com', owner: 'acme', repo: 'app' }, number: 7,
    title: 'Feature', url: 'https://github.com/acme/app/pull/7', headRef: 'me/task', baseRef: 'main',
    headOid: 'abc', state: 'open', fetchedAt: 1, via: 'gh' })
  let view: ReturnType<typeof create>
  act(() => { view = create(React.createElement(ChatHeaderPrChip, { state: { kind: 'pr', summary } })) })
  const button = view!.root.findByType('button')
  expect(button.props.title).toContain('chat.prWatch.savedUnrefreshed')
  expect(button.props['aria-label']).not.toContain('chat.prWatch.allGood')
  expect(view!.root.findAllByType('span').some(span => span.children.join('') === '#7')).toBe(true)
  act(() => button.props.onClick())
  expect(opened).toEqual([summary.url])
  act(() => view!.unmount())
})
