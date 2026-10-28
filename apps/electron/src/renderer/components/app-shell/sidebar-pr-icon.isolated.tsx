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
mock.module('@/hooks/usePrWatch', () => ({ usePrWatch: () => ({ state: { kind: 'pr', summary } }) }))
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
