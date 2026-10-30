import { describe, expect, it } from 'bun:test'
import type { BackgroundTask } from '@/atoms/sessions'
import {
  advanceBackgroundTaskChips,
  hasPendingSubagentWork,
  markBackgroundTaskSignal,
  markLiveBackgroundTasksOrphaned,
  ORPHANED_LINGER_MS,
  TERMINAL_LINGER_MS,
} from '../background-task-chip-state'

const NOW = 1_000_000_000

function task(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: 'task-1',
    type: 'agent',
    toolUseId: 'tool-1',
    startTime: NOW - 1_000,
    elapsedSeconds: 1,
    status: 'running',
    ...overrides,
  }
}

describe('pending subagent activity', () => {
  it('restores activity from the server when a reopened app has no task chips', () => {
    expect(hasPendingSubagentWork([], 2)).toBe(true)
    expect(hasPendingSubagentWork([], 0)).toBe(false)
  })

  it('does not let a stale client chip override confirmed server completion', () => {
    expect(hasPendingSubagentWork([task()], 0)).toBe(false)
  })
  it('keeps running agents active, including workflows', () => {
    expect(hasPendingSubagentWork([task()])).toBe(true)
    expect(hasPendingSubagentWork([task({ type: 'workflow' })])).toBe(true)
  })

  it('does not mistake a background server or monitor for an agent', () => {
    expect(hasPendingSubagentWork([task({ type: 'shell' }), task({ isSubagent: false })])).toBe(false)
  })

  it('stays active until the last agent finishes', () => {
    const finished = (['completed', 'failed', 'stopped', 'orphaned'] as const)
      .map(status => task({ status }))
    expect(hasPendingSubagentWork(finished)).toBe(false)
    expect(hasPendingSubagentWork([...finished, task()])).toBe(true)
    expect(hasPendingSubagentWork([])).toBe(false)
  })
})

describe('background task chip lifecycle', () => {
  for (const type of ['shell', 'agent', 'workflow'] as const) {
    it(`keeps a silent ${type} running after 20 minutes, one hour and one day`, () => {
      const tasks = [task({ type, startTime: NOW, lastSignalAt: NOW, elapsedSeconds: 0 })]
      for (const silence of [20 * 60_000, 60 * 60_000, 24 * 60 * 60_000]) {
        const next = advanceBackgroundTaskChips(tasks, NOW + silence)
        expect(next).toBe(tasks)
        expect(next[0]?.status).toBe('running')
        expect(next[0]?.completedAt).toBeUndefined()
      }
    })
  }

  it('retains and prunes terminal states using their existing linger windows', () => {
    const completedVisible = task({ status: 'completed', completedAt: NOW - TERMINAL_LINGER_MS + 1 })
    const completedExpired = task({ id: 'task-2', status: 'completed', completedAt: NOW - TERMINAL_LINGER_MS })
    const orphanVisible = task({ id: 'task-3', status: 'orphaned', completedAt: NOW - ORPHANED_LINGER_MS + 1 })
    const orphanExpired = task({ id: 'task-4', status: 'orphaned', completedAt: NOW - ORPHANED_LINGER_MS })

    const next = advanceBackgroundTaskChips([
      completedVisible,
      completedExpired,
      orphanVisible,
      orphanExpired,
    ], NOW)

    expect(next.map(item => item.id)).toEqual(['task-1', 'task-3'])
  })

  it('records progress without changing the server-confirmed running status', () => {
    const running = task({ lastSignalAt: NOW - 60 * 60_000 })
    const next = markBackgroundTaskSignal(running, NOW)

    expect(next.status).toBe('running')
    expect(next.lastSignalAt).toBe(NOW)
  })

  it('does not resurrect any terminal task on late progress', () => {
    for (const status of ['completed', 'failed', 'stopped', 'orphaned'] as const) {
      const ended = task({ status, completedAt: NOW - 1 })
      expect(markBackgroundTaskSignal(ended, NOW)).toBe(ended)
    }
  })

  it('only an actual turn teardown orphans running tasks', () => {
    const next = markLiveBackgroundTasksOrphaned([
      task(),
      task({ id: 'task-2', type: 'shell' }),
      task({ id: 'task-3', status: 'completed', completedAt: NOW - 1 }),
    ], NOW)

    expect(next.map(item => item.status)).toEqual(['orphaned', 'orphaned', 'completed'])
    expect(next[0]?.completedAt).toBe(NOW)
    expect(next[1]?.completedAt).toBe(NOW)
  })
})
