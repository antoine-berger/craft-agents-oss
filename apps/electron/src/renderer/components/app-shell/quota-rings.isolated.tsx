import { expect, mock, test } from 'bun:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import type { ProviderAccountQuota } from '@craft-agent/shared/protocol'
mock.module('@/components/ui/popover', () => ({ Popover: () => null, PopoverContent: () => null, PopoverTrigger: () => null }))
const { QuotaRings } = await import('./SidebarQuotaIndicator')

test('cached usage stays drawn when stale; missing windows never become fabricated zeroes', () => {
  const account: ProviderAccountQuota = { accountId: 'a', name: 'A', provider: 'claude', disabled: false, state: 'unavailable', freshness: 'stale', availability: 'unknown',
    observedAt: 1, checkedAt: 2, nextRefreshAt: null, windows: [{ id: 'five_hour', label: '5h', period: 'five_hour', usedPercent: 75, resetsAt: null, durationSeconds: 18000 }] }
  let view: ReturnType<typeof create>
  act(() => { view = create(<QuotaRings account={account} />) })
  const circles = view!.root.findAllByType('circle')
  expect(circles).toHaveLength(3)
  expect(circles[1]?.props.strokeDasharray).toBe(`${Math.PI * 2 * 11 * 0.75} ${Math.PI * 2 * 11}`)
  expect(circles[1]?.props.opacity).toBe(0.45)
  expect(circles[2]?.props.strokeDasharray).toBe('2 3')
  act(() => view!.unmount())
})
