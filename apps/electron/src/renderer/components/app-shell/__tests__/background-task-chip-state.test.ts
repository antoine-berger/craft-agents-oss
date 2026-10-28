import { describe, expect, it } from 'bun:test'
import type { BackgroundTask } from '@/atoms/sessions'
import {
  advanceBackgroundTaskChips,
  hasPendingSubagentWork,
  markBackgroundTaskSignal,
  markLiveBackgroundTasksOrphaned,
  ORPHANED_LINGER_MS,
  RUNNING_SIGNAL_TIMEOUT_MS,
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
    expect(hasPendingSubagentWork([task({ status: 'stale' })], 0)).toBe(false)
  })
  it('keeps running and stale agents active, including workflows', () => {
    expect(hasPendingSubagentWork([task()])).toBe(true)
    expect(hasPendingSubagentWork([task({ status: 'stale' })])).toBe(true)
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
  it('keeps a recently signaled running task unchanged', () => {
    const tasks = [task({ lastSignalAt: NOW - RUNNING_SIGNAL_TIMEOUT_MS + 1 })]

    expect(advanceBackgroundTaskChips(tasks, NOW)).toBe(tasks)
  })

  it('marks a no-signal running task stale without claiming completion', () => {
    const [stale] = advanceBackgroundTaskChips([
      task({ lastSignalAt: NOW - RUNNING_SIGNAL_TIMEOUT_MS }),
    ], NOW)

    expect(stale?.status).toBe('stale')
    expect(stale?.completedAt).toBeUndefined()
  })

  it('does not auto-prune stale tasks', () => {
    const tasks = [task({
      status: 'stale',
      startTime: NOW - 10 * RUNNING_SIGNAL_TIMEOUT_MS,
      lastSignalAt: NOW - 10 * RUNNING_SIGNAL_TIMEOUT_MS,
    })]

    expect(advanceBackgroundTaskChips(tasks, NOW)).toBe(tasks)
  })

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

  it('restores a stale task to running when progress resumes', () => {
    const stale = task({ status: 'stale', lastSignalAt: NOW - RUNNING_SIGNAL_TIMEOUT_MS })
    const next = markBackgroundTaskSignal(stale, NOW)

    expect(next.status).toBe('running')
    expect(next.lastSignalAt).toBe(NOW)
  })

  it('does not resurrect terminal tasks on late progress', () => {
    const completed = task({ status: 'completed', completedAt: NOW - 1 })

    expect(markBackgroundTaskSignal(completed, NOW)).toBe(completed)
  })

  it('turn teardown converts both running and stale tasks to true orphaned state', () => {
    const next = markLiveBackgroundTasksOrphaned([
      task(),
      task({ id: 'task-2', status: 'stale' }),
      task({ id: 'task-3', status: 'completed', completedAt: NOW - 1 }),
    ], NOW)

    expect(next.map(item => item.status)).toEqual(['orphaned', 'orphaned', 'completed'])
    expect(next[0]?.completedAt).toBe(NOW)
    expect(next[1]?.completedAt).toBe(NOW)
  })
})
