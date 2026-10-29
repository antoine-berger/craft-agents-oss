import type { ActivityItem } from '../TurnCard'
import { getInlineToolData } from './inline-tool-data'

/** Only successful file writes observed in this response; no session-wide Git diff is attributed. */
export function collectResponseFiles(activities: readonly ActivityItem[]): string[] {
  const paths = new Set<string>()
  for (const activity of activities) {
    if (activity.type !== 'tool' || activity.status !== 'completed') continue
    const data = getInlineToolData(activity)
    if (data.kind === 'edit') for (const edit of data.edits ?? []) paths.add(edit.path)
    if (data.kind === 'write' && data.path) paths.add(data.path)
  }
  return [...paths]
}
