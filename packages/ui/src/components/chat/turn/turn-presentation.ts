import type { ActivityItem, ResponseContent } from '../TurnCard'
import { groupActivitiesByParent, isActivityGroup, type ActivityGroup, type AssistantTurn } from '../turn-utils'

export type TranscriptItem =
  | { kind: 'activity'; activity: ActivityItem }
  | { kind: 'subagent'; group: ActivityGroup }
  | { kind: 'response'; response: ResponseContent }

export interface TranscriptMessage {
  id: string
  items: TranscriptItem[]
  isPreview: boolean
}

export interface TranscriptCounts {
  tools: number
  messages: number
  subagents: number
  failed: number
}

export type TranscriptSection =
  | { kind: 'message'; message: TranscriptMessage }
  | { kind: 'summary'; id: string; messages: TranscriptMessage[]; counts: TranscriptCounts; defaultExpanded: boolean }
  | { kind: 'mcp'; id: string; messages: TranscriptMessage[]; server: string; counts: TranscriptCounts }

export function isNarrativeActivity(activity: ActivityItem): boolean {
  return activity.type === 'intermediate' || activity.type === 'plan' || activity.type === 'thinking'
}

/** Search narrative blocks, not raw tool output; a promoted response appears once. */
export function getAssistantSearchText(turn: Pick<AssistantTurn, 'activities' | 'response'>): string {
  const messages = new Map<string, string>()
  for (const activity of turn.activities) {
    if (isNarrativeActivity(activity)) {
      messages.set(activity.messageId ?? activity.id, activity.content ?? '')
    }
  }
  if (turn.response) messages.set(turn.response.messageId ?? 'response', turn.response.text)
  return [...messages.values()].filter(Boolean).join('\n')
}

function backingActivity(item: TranscriptItem): ActivityItem | undefined {
  if (item.kind === 'activity') return item.activity
  if (item.kind === 'subagent') return item.group.parent
  return undefined
}

function sourceMessageId(item: TranscriptItem): string {
  if (item.kind === 'response') return item.response.sourceMessageId ?? item.response.messageId ?? 'response'
  const activity = backingActivity(item)!
  return activity.sourceMessageId ?? activity.id
}

function containsText(message: TranscriptMessage): boolean {
  return message.items.some(item => item.kind === 'response'
    ? !!item.response.text.trim()
    : item.kind === 'activity' && item.activity.type === 'intermediate' && !!item.activity.content?.trim())
}

function isPreviewBoundary(message: TranscriptMessage): boolean {
  return message.items.some(item => {
    if (item.kind !== 'activity') return false
    const activity = item.activity
    return activity.type === 'plan'
      || /(?:^|__)(?:AskUserQuestion|ExitPlanMode|SubmitPlan)$/i.test(activity.toolName ?? '')
  })
}

/** Preserve the last answer, questions and proposals while older work may collapse. */
function markPreviewMessages(messages: TranscriptMessage[]): void {
  let sawText = false
  let blockedByBoundary = false
  let sawPreview = false
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    const boundary = isPreviewBoundary(message)
    const text = containsText(message)
    if (boundary && !sawPreview) blockedByBoundary = true
    message.isPreview = boundary || (text && !sawText && !blockedByBoundary)
    if (text) sawText = true
    if (message.isPreview) sawPreview = true
  }
}

function countMessages(messages: TranscriptMessage[]): TranscriptCounts {
  const counts = { tools: 0, messages: 0, subagents: 0, failed: 0 }
  for (const message of messages) {
    let hasTool = false
    for (const item of message.items) {
      if (item.kind === 'subagent') {
        counts.subagents++
        hasTool = true
      } else if (item.kind === 'activity' && item.activity.type === 'tool') {
        counts.tools++
        hasTool = true
      }
      if (backingActivity(item)?.status === 'error') counts.failed++
    }
    if (!hasTool) counts.messages++
  }
  return counts
}

/** A source group contains tools from one external MCP server, never Craft's own session tools. */
function mcpServer(message: TranscriptMessage): string | undefined {
  if (message.isPreview) return undefined
  let server: string | undefined
  for (const item of message.items) {
    if (item.kind !== 'activity' || item.activity.type !== 'tool') return undefined
    const parts = item.activity.toolName?.split('__')
    if (!parts || parts.length !== 3 || parts[0] !== 'mcp' || !parts[1] || !parts[2] || parts[1] === 'conductor' || parts[1] === 'session') return undefined
    if (server !== undefined && server !== parts[1]) return undefined
    server = parts[1]
  }
  return server
}

export function groupMcpMessages(messages: TranscriptMessage[]): TranscriptSection[] {
  const sections: TranscriptSection[] = []
  for (const message of messages) {
    const server = mcpServer(message)
    const previous = sections.at(-1)
    if (server && previous?.kind === 'mcp' && previous.server === server) {
      previous.messages.push(message)
      previous.counts = countMessages(previous.messages)
    } else if (server) {
      sections.push({ kind: 'mcp', id: `mcp:${message.id}`, server, messages: [message], counts: countMessages([message]) })
    } else {
      sections.push({ kind: 'message', message })
    }
  }
  return sections
}

function groupCompletedMessages(messages: TranscriptMessage[]): TranscriptSection[] {
  const sections: TranscriptSection[] = []
  let pending: TranscriptMessage[] = []
  const flush = () => {
    if (pending.length >= 3) {
      sections.push({
        kind: 'summary',
        id: `summary:${pending[0]!.id}`,
        messages: pending,
        counts: countMessages(pending),
        defaultExpanded: pending.some(message => message.items.some(item => /ImageGeneration/i.test(backingActivity(item)?.toolName ?? ''))),
      })
    } else {
      sections.push(...groupMcpMessages(pending))
    }
    pending = []
  }
  for (const message of messages) {
    if (message.isPreview) {
      flush()
      sections.push({ kind: 'message', message })
    } else {
      pending.push(message)
    }
  }
  flush()
  return sections
}

/**
 * Display projection only. A source message may hold several tools; the collapse
 * threshold counts messages, not individual tools or a subagent's child rows.
 */
export function buildTurnPresentation(
  activities: ActivityItem[],
  response: ResponseContent | undefined,
  isComplete: boolean,
): TranscriptSection[] {
  const sorted = activities
    .filter(activity => !response?.messageId || activity.id !== response.messageId || !!activity.parentId)
    .slice()
    .sort((left, right) => left.timestamp - right.timestamp)
  // SubmitPlan's success is represented by the annotated proposal that follows
  // it. Failed submissions and historical calls without a proposal still show.
  const presented = sorted.filter((activity, index) => {
    if (activity.status !== 'completed' || !/(?:^|__)SubmitPlan$/i.test(activity.toolName ?? '')) return true
    for (const following of sorted.slice(index + 1)) {
      if (following.parentId !== activity.parentId) continue
      if (following.type === 'plan') return false
      if (/(?:^|__)SubmitPlan$/i.test(following.toolName ?? '')) break
    }
    return true
  })
  const grouped = groupActivitiesByParent(presented)
  const items: TranscriptItem[] = grouped.map(item => isActivityGroup(item)
    ? { kind: 'subagent', group: item }
    : { kind: 'activity', activity: item })
  if (response) items.push({ kind: 'response', response })

  const messages: TranscriptMessage[] = []
  for (const item of items) {
    const id = sourceMessageId(item)
    const previous = messages.at(-1)
    if (previous?.id === id) previous.items.push(item)
    else messages.push({ id, items: [item], isPreview: false })
  }
  markPreviewMessages(messages)
  return isComplete ? groupCompletedMessages(messages) : groupMcpMessages(messages)
}
