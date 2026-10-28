/** The main session's live agents only: shell servers and Monitor tasks do not block a turn. */
export function countBackgroundAgents(tasks: Iterable<{
  status: string
  kind?: string
  untracked?: boolean
}>): number {
  let count = 0
  for (const task of tasks) {
    if (task.status === 'running' && !task.untracked && (task.kind === 'agent' || task.kind === 'workflow')) count++
  }
  return count
}
