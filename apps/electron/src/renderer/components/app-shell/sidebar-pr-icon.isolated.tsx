import { expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PrSummary } from '@craft-agent/shared/protocol'
import type { SessionMeta } from '@/atoms/sessions'

let summary: PrSummary = {
  number: 1, title: 'Feature', url: 'https://github.com/example/repo/pull/1',
  state: 'open', headRef: 'feature', baseRef: 'main', checks: 'success',
  reviewDecision: 'approved', mergeState: 'clean', unresolvedThreads: 0,
  localAhead: 0, localDirty: false, fetchedAt: 1, via: 'gh',
}
const priorities: Array<boolean | undefined> = []
mock.module('@/hooks/usePrWatch', () => ({ usePrWatch: (_id: string, _enabled: boolean, _dir: string, isForeground?: boolean) => {
  priorities.push(isForeground)
  return { state: { kind: 'pr', summary } }
} }))
mock.module('@/context/AppShellContext', () => ({ useAppShellContext: () => ({ onOpenUrl: () => {} }) }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
mock.module('@craft-agent/ui', () => ({ Spinner: () => null }))

const { SessionStatusIcon } = await import('./SessionStatusIcon')
const { ChatHeaderPrChip } = await import('./chat-header/pr-watch/ChatHeaderPrChip')
const item = { id: 'session' } as SessionMeta

test('sidebar and header render the rebase and merge queue icons with matching labels', () => {
  for (const queued of [false, true]) {
    summary = { ...summary, mergeState: 'behind', quickActions: queued ? {
      canMerge: true, methods: ['squash'], defaultMethod: 'squash', mergeQueue: true,
      queued: { state: 'QUEUED', position: 2 },
    } : undefined }
    for (const element of [
      <SessionStatusIcon item={item} />,
      <ChatHeaderPrChip state={{ kind: 'pr', summary }} />,
    ]) {
      const html = renderToStaticMarkup(element)
      expect(html).toContain(queued ? 'lucide-list-ordered' : 'lucide-git-pull-request-arrow')
      expect(html).toContain(queued ? 'chat.queuedBadge' : 'chat.prWatch.merge.behind')
    }
  }
})

test('the actual sidebar row subscribes at background priority', () => {
  priorities.length = 0
  renderToStaticMarkup(<SessionStatusIcon item={item} />)
  expect(priorities).toEqual([false])
})

test('sidebar and header reproduce Conductor conflict SVG geometry and light/dark colors', () => {
  summary = { ...summary, state: 'open', mergeState: 'conflicting', attentionStale: false, quickActions: undefined }
  // G5a and IWt/s5e from the verified installed Conductor 0.92.0 renderer.
  const conductorNodes = [
    ['path', { d: 'M12 6h4a2 2 0 0 1 2 2v7' }],
    ['path', { d: 'M6 12v9' }],
    ['path', { d: 'M9 3 3 9' }],
    ['path', { d: 'M9 9 3 3' }],
    ['circle', { cx: '18', cy: '18', r: '3' }],
  ]
  for (const element of [<SessionStatusIcon item={item} />, <ChatHeaderPrChip state={{ kind: 'pr', summary }} />]) {
    const html = renderToStaticMarkup(element)
    expect(html).toContain('lucide-git-pull-request-conflict')
    expect(html).toContain('text-[#cca694] dark:text-[#ddc1b1]')
    expect(html).not.toContain('text-destructive')
    expect(html).toContain('chat.prWatch.merge.conflicting')
    expect(html).toContain('viewBox="0 0 24 24"')
    expect(html).toContain('fill="none"')
    expect(html).toContain('stroke="currentColor"')
    expect(html).toContain('stroke-width="2"')
    expect(html).toContain('stroke-linecap="round"')
    expect(html).toContain('stroke-linejoin="round"')
    const nodes = [...html.matchAll(/<(path|circle)\b([^>]*)>/g)].map(([, tag, attributes]) => [
      tag, Object.fromEntries([...attributes!.matchAll(/\b(d|cx|cy|r)="([^"]*)"/g)].map(([, key, value]) => [key, value])),
    ])
    expect(nodes).toEqual(conductorNodes)
  }
})

test('rendered merge-queue and draft icons win over a conflict like Conductor', () => {
  for (const queued of [false, true]) {
    summary = { ...summary, state: 'draft', mergeState: 'conflicting', quickActions: queued ? {
      canMerge: true, methods: ['squash'], defaultMethod: 'squash', mergeQueue: true,
      queued: { state: 'QUEUED', position: 2 },
    } : undefined }
    for (const element of [<SessionStatusIcon item={item} />, <ChatHeaderPrChip state={{ kind: 'pr', summary }} />]) {
      const html = renderToStaticMarkup(element)
      expect(html).toContain(queued ? 'lucide-list-ordered' : 'lucide-git-pull-request-draft')
      expect(html).not.toContain('lucide-git-pull-request-conflict')
      expect(html).not.toContain('text-[#cca694]')
    }
  }
})

test('conflicts preserve owner-attention and running-agent indicators', () => {
  summary = { ...summary, state: 'open', mergeState: 'conflicting', attentionStale: false }
  const attention = renderToStaticMarkup(<SessionStatusIcon item={item} needsAttention />)
  expect(attention).toContain('lucide-hand')
  expect(attention).not.toContain('lucide-git-pull-request-conflict')
  const working = renderToStaticMarkup(<SessionStatusIcon item={item} isWorking />)
  expect(working).toContain('session.runState.working')
  expect(working).not.toContain('lucide-git-pull-request-conflict')
  const waiting = renderToStaticMarkup(<SessionStatusIcon item={item} isWaitingForSubagents />)
  expect(waiting).toContain('session.runState.subagents')
  expect(waiting).toContain('text-secondary')
  expect(waiting).not.toContain('lucide-git-pull-request-conflict')
  expect(waiting).not.toContain('text-[#cca694]')
})
