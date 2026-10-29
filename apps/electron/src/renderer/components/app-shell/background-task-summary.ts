import type { BackgroundTask } from '@/atoms/sessions'

export function summarizeBackgroundTasks(tasks: readonly BackgroundTask[], now: number) {
  const pending = tasks.filter(task => task.status === 'running' || task.status === 'stale')
  const running = pending.some(task => task.status === 'running')
  const source = pending.length ? pending : tasks
  const first = source[0]
  if (!first) return null
  const allAgents = source.every(task => task.type === 'agent' && task.isSubagent !== false)
  const title = first.intent?.trim()
  let label: string
  if (!pending.length) label = first.summary?.trim() || title || first.id
  else if (source.every(task => task.stopping)) label = 'Stopping…'
  else if (!running) label = `No signal${title ? ` · ${title}` : ''}`
  else if (source.length > 1) label = `Waiting for ${source.length} ${allAgents ? 'agents' : 'background tasks'}`
  else if (title) label = `Waiting for ${allAgents ? 'subagent' : 'task'} ${title}`
  else label = `Waiting for ${allAgents ? 'agent' : 'background task'}`
  const started = Math.min(...source.map(task => task.startTime))
  const ended = pending.length ? now : Math.max(...source.map(task => task.completedAt ?? task.startTime))
  const recorded = Math.max(...source.map(task => task.elapsedSeconds))
  return { label, running, pending: !!pending.length, elapsed: Math.max(0, recorded, Math.floor((ended - started) / 1000)) }
}
