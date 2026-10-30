import { expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PrSummary, PrWatchState } from '@craft-agent/shared/protocol'
import type { SessionMeta } from '@/atoms/sessions'
import reference from './__tests__/fixtures/conductor-status-icons.json'

let state: PrWatchState = { kind: 'none' }
const priorities: Array<boolean | undefined> = []
mock.module('@/hooks/usePrWatch', () => ({ usePrWatch: (_id: string, _enabled: boolean, _dir: string, foreground?: boolean) => {
  priorities.push(foreground); return { state }
} }))
mock.module('@/context/AppShellContext', () => ({ useAppShellContext: () => ({ onOpenUrl: () => {} }) }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
mock.module('@craft-agent/ui', () => ({ Spinner: () => null }))
const { SessionStatusIcon } = await import('./SessionStatusIcon')
const { ChatHeaderPrChip } = await import('./chat-header/pr-watch/ChatHeaderPrChip')
const { PR_STATUS_ICON, PR_STATUS_COLOR, SESSION_STATUS_ICON, STATUS_COLOR } = await import('./conductor-status-icons')
const item = { id: 'session' } as SessionMeta

function referenceColor(state: keyof typeof PR_STATUS_COLOR): string {
  if (state === 'merged') return 'text-purple-500'
  const token = ({ queued: 'status-in-progress', ready: 'git-green', conflicting: 'highlight-muted', 'checks-failing': 'destructive' } as Record<string, keyof typeof reference.colors>)[state] ?? 'sidebar-muted-foreground'
  const expand = (color: string) => /^#[0-9a-f]{3,4}$/i.test(color) ? '#' + [...color.slice(1)].map(value => value + value).join('') : color
  const [light, dark] = reference.colors[token]
  return `text-[${expand(light!)}] dark:text-[${expand(dark!)}]`
}

type Definition = { fill: string; stroke: string; viewBox: string; strokeWidth?: number; strokeLinecap?: string; strokeLinejoin?: string; nodes: Array<Record<string, string | number | undefined>> }
function geometry(html: string, expected: Definition) {
  for (const [attribute, value] of Object.entries({ fill: expected.fill, stroke: expected.stroke, viewBox: expected.viewBox,
    'stroke-width': expected.strokeWidth, 'stroke-linecap': expected.strokeLinecap, 'stroke-linejoin': expected.strokeLinejoin })) {
    if (value !== undefined) expect(html).toContain(`${attribute}="${value}"`)
  }
  const nodes: Array<Record<string, string>> = [...html.matchAll(/<(path|circle|line|rect)\b([^>]*)>/g)].map(([, kind, attributes]) => ({ kind,
    ...Object.fromEntries([...attributes!.matchAll(/\b(d|cx|cy|r|x1|x2|y1|y2|width|height|x|y|rx|ry)="([^"]*)"/g)].map(([, key, value]) => [key, value])) }))
  expect(nodes).toEqual(expected.nodes.map(node => Object.fromEntries(Object.entries(node).map(([key, value]) => [key, String(value)]))))
}

test('all classic glyphs reproduce the verified Conductor SVG definitions', () => {
  const definitions = reference.icons as Record<string, Definition>
  for (const [name, Icon] of Object.entries({ ...PR_STATUS_ICON, ...SESSION_STATUS_ICON })) {
    const expected = definitions[name === 'closed' ? 'branch' : name]!
    geometry(renderToStaticMarkup(<Icon />), expected)
  }
})

test('sidebar and header use Conductor status priorities, geometry and colors', () => {
  for (const vector of reference.cases) {
    const summary = vector.summary as PrSummary
    state = { kind: 'pr', summary }
    const expected = vector.expected as keyof typeof PR_STATUS_COLOR
    for (const element of [<SessionStatusIcon item={item} />, <ChatHeaderPrChip state={state} />]) {
      const html = renderToStaticMarkup(element)
      expect(PR_STATUS_COLOR[expected]).toBe(referenceColor(expected))
      expect(html).toContain(referenceColor(expected))
      geometry(html, (reference.icons as Record<string, Definition>)[expected === 'closed' ? 'branch' : expected]!)
    }
  }
})

test('yellow hand is kept for all requested owner-attention cases, above PR status', () => {
  state = { kind: 'pr', summary: reference.cases.find(vector => vector.expected === 'merged')!.summary as PrSummary }
  for (const runState of ['plan', 'permission', 'question'] as const) {
    const html = renderToStaticMarkup(<SessionStatusIcon item={item} runState={runState} />)
    expect(html).toContain('lucide-hand')
    expect(html).toContain('text-yellow-600 dark:text-yellow-400')
    expect(html).not.toContain('lucide-conductor-merged')
  }
})

test('activity and waiting use the same muted colors and failed requests use the failure glyph', () => {
  for (const runState of ['working', 'waiting'] as const) {
    const html = renderToStaticMarkup(<SessionStatusIcon item={item} runState={runState} />)
    expect(html).toContain(STATUS_COLOR.neutral)
    expect(html).toContain(runState === 'waiting' ? 'session-activity-waiting' : 'session-activity-working')
    expect(html).not.toContain('lucide-conductor-merged')
  }
  const failed = renderToStaticMarkup(<SessionStatusIcon item={item} runState="failed" />)
  expect(failed).toContain(STATUS_COLOR.failed)
  geometry(failed, reference.icons.failed)
})

test('real not-git and empty-session metadata select the local and unstarted glyphs', () => {
  state = { kind: 'unavailable', reason: 'not-git' }
  geometry(renderToStaticMarkup(<SessionStatusIcon item={item} />), reference.icons.local)
  state = { kind: 'none' }
  geometry(renderToStaticMarkup(<SessionStatusIcon item={{ ...item, messageCount: 0 }} />), reference.icons.unstarted)
  geometry(renderToStaticMarkup(<SessionStatusIcon item={item} />), reference.icons.branch)
})

test('the actual sidebar row remains a background subscription with a 14px icon in a 16px slot', () => {
  priorities.length = 0
  const html = renderToStaticMarkup(<SessionStatusIcon item={item} />)
  expect(priorities).toEqual([false])
  expect(html).toContain('size-4')
  expect(html).toContain('[&amp;&gt;svg]:size-3.5')
})
