import * as React from 'react'
import { Bot, Check, CircleAlert } from 'lucide-react'
import { Markdown } from '../../markdown'
import { Spinner } from '../../ui/LoadingIndicator'
import type { ActivityItem } from '../TurnCard'
import { groupActivitiesByParent, isActivityGroup, type ActivityGroup } from '../turn-utils'
import { cn } from '../../../lib/utils'
import { InlineDisclosure, InlineToolBlock, type InlineToolBlockProps } from './InlineToolBlock'
import { stringField, subagentResult } from './inline-tool-data'

export interface InlineSubagentBlockProps extends Omit<InlineToolBlockProps, 'activity'> {
  group: ActivityGroup
  renderMessage?: (activity: ActivityItem) => React.ReactNode
  /** Bounds malformed imported parent graphs; native subagents normally have only a few levels. */
  nestingDepth?: number
}

/** Direct children become roots for the recursive transcript without changing stored ownership. */
export function subagentChildren(group: ActivityGroup): (ActivityItem | ActivityGroup)[] {
  const children = group.children.map(child => child.parentId === group.parent.toolUseId
    ? { ...child, parentId: undefined } : child)
  const grouped = groupActivitiesByParent(children)
  const represented = new Set(grouped.flatMap(item => isActivityGroup(item)
    ? [item.parent.id, ...item.children.map(child => child.id)] : [item.id]))
  // A malformed parent cycle must not hide captured messages beside an otherwise valid group.
  return [...grouped, ...children.filter(child => !represented.has(child.id))]
}

/** Stop increasing indentation for deep/imported graphs, retaining every captured descendant. */
export function flattenSubagentGroup(group: ActivityGroup): ActivityItem[] {
  return [...new Map([group.parent, ...group.children].map(item => [item.id, item])).values()]
    .sort((left, right) => left.timestamp - right.timestamp)
}

export function InlineSubagentBlock({ group, sessionId, sessionFolderPath, searchQuery, openMessageId, onOpenFile, onOpenUrl,
  onOpenDetails, renderMessage, nestingDepth = 0,
}: InlineSubagentBlockProps) {
  const parent = group.parent
  const error = parent.status === 'error'
  const active = !error && (parent.status === 'running' || parent.status === 'pending' || parent.status === 'backgrounded'
    || group.children.some(child => child.status === 'running' || child.status === 'pending' || child.status === 'backgrounded'))
  const description = stringField(parent.toolInput, 'description')
  const type = stringField(parent.toolInput, 'subagent_type') || 'Agent'
  const requestedModel = stringField(parent.toolInput, 'model')
  const prompt = stringField(parent.toolInput, 'prompt')
  const result = !active && !group.continued ? subagentResult(parent) : ''
  const childItems = React.useMemo(() => subagentChildren(group), [group])
  const resultAlreadyVisible = result && group.children.some(child => child.type === 'intermediate' && child.content?.trim() === result.trim())
  const renderActivity = (activity: ActivityItem) => {
    if (activity.type === 'intermediate' || activity.type === 'plan') {
      return renderMessage ? renderMessage(activity)
        : <Markdown mode="chat" onFileClick={onOpenFile} onUrlClick={onOpenUrl}>{activity.content || ''}</Markdown>
    }
    if (activity.type === 'status') return <div className="py-1 text-xs text-secondary">{activity.content}</div>
    return <InlineToolBlock activity={activity} sessionId={sessionId} sessionFolderPath={sessionFolderPath}
      searchQuery={searchQuery} openMessageId={openMessageId} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} onOpenDetails={onOpenDetails} />
  }

  return <InlineDisclosure id={`agent:${parent.id}`} sessionId={sessionId}
    forceExpanded={Boolean(group.children.some(child => (openMessageId && (child.messageId ?? child.id) === openMessageId)
      || (searchQuery?.trim() && ['intermediate', 'plan', 'thinking'].includes(child.type)
        && child.content?.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase()))))}
    icon={active ? <Spinner className="size-3.5" /> : error ? <CircleAlert className="size-3.5 text-destructive" /> : <Check className="size-3.5" />}
    title={<span className="inline-flex items-center gap-1.5">{type}
      {requestedModel && <><span className="text-secondary">·</span><span className="text-secondary" title="Requested model">{requestedModel}</span></>}
    </span>}
    preview={description || (group.continued ? 'Continued' : undefined)} error={error}
    onOpenDetails={onOpenDetails && !group.continued ? () => onOpenDetails(parent) : undefined}
    bodyClassName="ml-1.5 space-y-1 border-l border-subtle pl-4">
    {prompt && <InlineDisclosure id={`prompt:${parent.id}`} sessionId={sessionId} icon={<Bot className="size-3.5" />} title="Prompt">
      <div className="select-text whitespace-pre-wrap text-sm leading-6 text-secondary">{prompt}</div>
    </InlineDisclosure>}
    {childItems.map(item => <div key={isActivityGroup(item) ? item.parent.id : item.id}>
      {isActivityGroup(item) && nestingDepth < 12
        ? <InlineSubagentBlock group={item} sessionId={sessionId} sessionFolderPath={sessionFolderPath}
          searchQuery={searchQuery} openMessageId={openMessageId}
          onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} onOpenDetails={onOpenDetails}
          renderMessage={renderMessage} nestingDepth={nestingDepth + 1} />
        : isActivityGroup(item)
          ? flattenSubagentGroup(item).map(activity => <div key={activity.id}>{renderActivity(activity)}</div>)
          : renderActivity(item)}
    </div>)}
    {result && !resultAlreadyVisible && <div className={cn('pt-1', error && 'text-destructive')}>
      <Markdown mode="chat" onFileClick={onOpenFile} onUrlClick={onOpenUrl}>{result}</Markdown>
    </div>}
  </InlineDisclosure>
}
