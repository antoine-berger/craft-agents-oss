import type { BackgroundTask } from '@/atoms/sessions'

/** A reply is not finished while its agents are running. */
export function hasPendingSubagentWork(tasks: readonly BackgroundTask[], serverCount?: number): boolean {
  // A fresh server snapshot wins over missing or stale renderer-only task chips.
  if (serverCount !== undefined) return serverCount > 0
  return tasks.some(task => task.type !== 'shell' && task.isSubagent !== false
    && task.status === 'running')
}

/** Sidebar activity includes external reviewers and their background wait tasks, not only native agents. */
export function hasPendingBackgroundWork(tasks: readonly BackgroundTask[], serverAgentCount?: number): boolean {
  return hasPendingSubagentWork(tasks, serverAgentCount)
    || tasks.some(task => (task.type === 'shell' || task.isSubagent === false)
      && task.status === 'running')
}

/** How long real terminal/orphaned chips remain visible. */
export const TERMINAL_LINGER_MS = 8_000
export const ORPHANED_LINGER_MS = 20_000

/**
 * Prune only states known to be terminal. Silence never changes a server-reported running task.
 * `keepId` is the chip whose card is open: it stays until the card closes.
 * Returns the original array when nothing changed to avoid spurious Jotai renders.
 */
export function advanceBackgroundTaskChips(
  tasks: BackgroundTask[],
  now: number,
  keepId?: string | null,
): BackgroundTask[] {
  const next = tasks.filter((task) => {
    if (task.status === 'running' || task.id === keepId) return true
    const age = now - (task.completedAt ?? now)
    const linger = task.status === 'orphaned'
      ? ORPHANED_LINGER_MS
      : TERMINAL_LINGER_MS
    return age < linger
  })

  return next.length !== tasks.length ? next : tasks
}

/**
 * Record server progress without resurrecting a task that has already ended.
 */
export function markBackgroundTaskSignal(
  task: BackgroundTask,
  now: number,
): BackgroundTask {
  if (task.status !== 'running') return task
  return {
    ...task,
    lastSignalAt: now,
  }
}

/**
 * Turn-end death is authoritative only when the backend did not keep background tasks alive.
 */
export function markLiveBackgroundTasksOrphaned(
  tasks: BackgroundTask[],
  now: number,
): BackgroundTask[] {
  let changed = false
  const next = tasks.map((task) => {
    if (task.status !== 'running') return task
    changed = true
    return {
      ...task,
      status: 'orphaned' as const,
      stopping: false,
      completedAt: now,
    }
  })
  return changed ? next : tasks
}
