import * as React from 'react'
import { ArrowUpRight, Bot, Brain, ChevronRight, Circle, CircleAlert, Copy, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/utils'
import { useShikiTheme } from '../../../context/ShikiThemeContext'
import { Markdown } from '../../markdown'
import { highlightChatCode } from '../../markdown/chat-code-highlight'
import { getLanguageFromPath, ShikiDiffViewer, UnifiedDiffViewer } from '../../code-viewer'
import { stripAnsi } from '../../terminal/ansi-parser'
import { Spinner } from '../../ui/LoadingIndicator'
import type { ActivityItem } from '../TurnCard'
import { ToolIcon } from './ActivityIcons'
import { computeEditWriteDiffStats, formatToolDisplay } from './tool-display'
import { collaborationData, getInlineToolData, inlineOutput, inlineToolInput, todoStatusRows, type CollaborationData, type InlineEdit, type InlineToolData } from './inline-tool-data'

export interface InlineDisclosureProps {
  id: string
  sessionId?: string
  icon?: React.ReactNode
  title: React.ReactNode
  preview?: React.ReactNode
  children?: React.ReactNode
  defaultExpanded?: boolean
  isExpanded?: boolean
  forceExpanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  alwaysShowPreview?: boolean
  previewInteractive?: boolean
  collapsible?: boolean
  error?: boolean
  bodyClassName?: string
  onOpenDetails?: () => void
}

function savedExpansion(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key)
    return value === null ? fallback : value === 'true'
  } catch { return fallback }
}

/** One transcript disclosure, shared by tools, work summaries and nested agents. */
export function InlineDisclosure({ id, sessionId, icon, title, preview, children, defaultExpanded = false,
  isExpanded, forceExpanded, onExpandedChange, alwaysShowPreview, previewInteractive, collapsible = true, error, bodyClassName, onOpenDetails,
}: InlineDisclosureProps) {
  const { t } = useTranslation()
  const storageKey = `craft.chat.disclosure:${sessionId ?? 'viewer'}:${id}`
  const [localState, setLocalState] = React.useState(() => ({ key: storageKey, expanded: savedExpansion(storageKey, defaultExpanded) }))
  const localExpanded = localState.key === storageKey ? localState.expanded : savedExpansion(storageKey, defaultExpanded)
  const expanded = forceExpanded || (isExpanded ?? localExpanded)
  const contentId = React.useId()
  const setExpanded = (next: boolean) => {
    if (forceExpanded) return
    setLocalState({ key: storageKey, expanded: next })
    try { localStorage.setItem(storageKey, String(next)) } catch { /* Storage can be unavailable in a read-only viewer. */ }
    onExpandedChange?.(next)
  }
  const label = <>
    <span className="relative flex size-4 shrink-0 items-center justify-center text-secondary [&_svg]:size-3.5">
      <span className={cn('flex items-center', collapsible && 'group-hover/disclosure:hidden group-focus-within/disclosure:hidden')}>{icon}</span>
      {collapsible && <ChevronRight aria-hidden className={cn('absolute hidden size-3.5 group-hover/disclosure:block group-focus-within/disclosure:block', expanded && 'rotate-90')} />}
    </span>
    <span className={cn('shrink-0 truncate text-[14px] leading-5', error && 'text-destructive')}>{title}</span>
  </>
  const previewContent = preview && <span className={cn('min-w-0 max-w-[400px] truncate font-mono text-[12px] font-medium text-secondary',
    expanded && !alwaysShowPreview && 'invisible', error && 'text-destructive')}>{preview}</span>

  return (
    <div className="group/disclosure relative min-w-0" data-inline-tool={id}>
      <div className="-mx-2 inline-flex max-w-full items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-foreground/5">
        {collapsible ? <button type="button" aria-expanded={expanded} aria-controls={contentId}
          className="inline-flex min-w-0 items-center gap-2 text-left"
          onClick={() => setExpanded(!expanded)}>{label}{!previewInteractive && previewContent}</button>
          : <div className="inline-flex min-w-0 items-center gap-2">{label}{!previewInteractive && previewContent}</div>}
        {previewInteractive && previewContent}
        {onOpenDetails && <button type="button" onClick={onOpenDetails} aria-label={t('chat.viewOutput')}
          title={t('chat.viewOutput')} className="ml-2 flex size-5 shrink-0 items-center justify-center rounded text-secondary opacity-0 hover:bg-foreground/5 focus-visible:opacity-100 group-hover/disclosure:opacity-100 group-focus-within/disclosure:opacity-100">
          <ArrowUpRight aria-hidden className="size-3.5" />
        </button>}
      </div>
      {collapsible && expanded && <div id={contentId} className={cn('mt-2 min-w-0 select-text', bodyClassName)}>{children}</div>}
    </div>
  )
}

export interface InlineToolBlockProps {
  activity: ActivityItem
  sessionId?: string
  sessionFolderPath?: string
  searchQuery?: string
  openMessageId?: string
  onOpenFile?: (path: string) => void
  onOpenUrl?: (url: string) => void
  onOpenDetails?: (activity: ActivityItem) => void
}

class ToolResultBoundary extends React.Component<{ children: React.ReactNode; fallback: React.ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

function ToolCode({ code, language, path }: { code: string; language?: string; path?: string }) {
  const resolvedLanguage = language || (path ? getLanguageFromPath(path) : 'text')
  const html = React.useMemo(() => highlightChatCode(code, resolvedLanguage), [code, resolvedLanguage])
  return <pre data-code-appearance="chat" className="m-0 whitespace-pre font-mono text-[12px] font-medium leading-4">
    {html ? <code className="hljs" style={{ fontWeight: 'inherit' }} dangerouslySetInnerHTML={{ __html: html }} />
      : <code style={{ fontWeight: 'inherit' }}>{code || '\u200b'}</code>}
  </pre>
}

function ReadResult({ code, path, startLine = 1 }: { code: string; path?: string; startLine?: number }) {
  return <div className="w-full min-w-max overflow-hidden rounded-lg border border-subtle bg-sunken font-mono text-[12px] font-medium leading-4">
    {code.split('\n').map((line, index) => <div key={index} className="flex">
      <div aria-hidden className="w-12 shrink-0 select-none px-2 py-1 text-right text-tertiary">{startLine + index}</div>
      <div className="min-w-0 flex-1 border-l border-subtle py-1 pl-2 pr-4"><ToolCode code={line} path={path} /></div>
    </div>)}
  </div>
}

function EditResult({ edits }: { edits: InlineEdit[] }) {
  const shikiTheme = useShikiTheme()
  const theme = typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  return <div className="space-y-2">{edits.map((edit, index) => <div key={`${edit.path}:${index}`} className="overflow-hidden">
    {edits.length > 1 && <div className="mb-1 truncate font-mono text-xs text-secondary">{edit.path}</div>}
    {edit.patch !== undefined
      ? <UnifiedDiffViewer unifiedDiff={edit.patch} filePath={edit.path} theme={theme} shikiTheme={shikiTheme ?? undefined} />
      : <ShikiDiffViewer original={edit.original} modified={edit.modified} filePath={edit.path} theme={theme} shikiTheme={shikiTheme ?? undefined} />}
  </div>)}</div>
}

function MultiEditResult({ edits }: { edits: InlineEdit[] }) {
  const [expanded, setExpanded] = React.useState<Set<number>>(new Set())
  return <div className="divide-y divide-subtle">{edits.map((edit, index) => {
    const stats = edit.patch !== undefined ? computeEditWriteDiffStats('Edit', { changes: [{ path: edit.path, diff: edit.patch }] })
      : computeEditWriteDiffStats('Edit', { old_string: edit.original, new_string: edit.modified })
    const old = edit.original || ''
    return <div key={index}><button type="button" aria-expanded={expanded.has(index)}
      className="flex w-full items-center gap-2 p-3 text-left text-xs hover:bg-foreground/5"
      onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(index)) next.delete(index); else next.add(index); return next })}>
      <span className="shrink-0 font-medium">Edit {index + 1}</span>
      {Boolean(stats?.additions) && <span className="shrink-0 text-success">+{stats!.additions}</span>}
      {Boolean(stats?.deletions) && <span className="shrink-0 text-destructive">−{stats!.deletions}</span>}
      <span className="min-w-0 flex-1 truncate text-secondary">{old.split('\n')[0]?.slice(0, 40) || 'Empty'}{old.length > 40 ? '…' : ''}</span>
    </button>{expanded.has(index) && <div className="border-t border-subtle p-2"><EditResult edits={[edit]} /></div>}</div>
  })}</div>
}

function TodoResult({ data, activity, sessionId }: { data: InlineToolData; activity: ActivityItem; sessionId?: string }) {
  const todos = data.todos || []
  return <>{todoStatusRows(todos).map(row => <InlineDisclosure key={row.id} id={`${activity.id}:${row.id}`} sessionId={sessionId}
    icon={<ToolIcon toolName="TodoWrite" />} title={row.title} preview={<span className="font-sans font-normal">{row.preview}</span>}>
    {todos.length ? <div className="space-y-2">{todos.map((todo, index) => <div key={index}
      className={cn('flex items-center gap-2 transition-opacity', todo.status === 'completed' && 'opacity-60')}>
      <span className="mt-0.5">{todo.status === 'completed' ? <Check className="size-4 text-success" />
        : todo.status === 'in_progress' ? <Spinner className="size-4" /> : <Circle className="size-4 text-secondary" />}</span>
      <p className={cn('min-w-0 flex-1 break-words text-xs', todo.status === 'completed' && 'line-through')}>{todo.content}</p>
    </div>)}</div> : <p className="p-3 text-xs italic text-secondary">No todos</p>}
  </InlineDisclosure>)}</>
}

function WriteResult({ code, path }: { code: string; path?: string }) {
  const [showAll, setShowAll] = React.useState(false)
  const preview = showAll ? code : code.slice(0, 2_000)
  return <div>
    <EditResult edits={[{ path: path || 'file', original: '', modified: preview }]} />
    {code.length > 2_000 && <div className="mt-2 flex items-center justify-between border-t border-subtle pt-2 text-xs text-secondary">
      <span>{code.length.toLocaleString()} characters</span>
      <button type="button" className="rounded px-2 py-1 hover:bg-foreground/5" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show less' : 'Show more'}</button>
    </div>}
  </div>
}

function QuestionResult({ data }: { data: InlineToolData }) {
  const recorded = new Map<number, string>()
  if (data.output.startsWith('User responses:')) {
    let current: number | undefined
    for (const line of data.output.split('\n').slice(1)) {
      const match = line.match(/^(\d+)\.\s(.*)$/)
      if (match) {
        current = Number(match[1]) - 1
        recorded.set(current, match[2]!)
      } else if (current !== undefined) recorded.set(current, `${recorded.get(current)}\n${line.startsWith('   ') ? line.slice(3) : line}`)
    }
  }
  const cancelled = data.output.startsWith('User cancelled')
  return <div className="space-y-3 font-sans text-xs leading-5">
    {data.questions?.map((question, index) => <div key={index}>
      <div className="select-text border-l-2 border-subtle pl-2 text-secondary">{question.question}</div>
      {recorded.has(index) ? <div className="mt-1 select-text whitespace-pre-wrap font-medium">{recorded.get(index)}</div>
        : !cancelled && <div className="mt-1 text-xs text-secondary">{question.options.map(option => option.label).join(' · ')}</div>}
    </div>)}
    {cancelled && <div className="text-secondary">Cancelled</div>}
    {!cancelled && data.output && !data.output.startsWith('User responses:') && <div className="whitespace-pre-wrap text-secondary">{data.output}</div>}
  </div>
}

function InlineToolBody({ data, activity, onOpenFile, onOpenUrl }: InlineToolBlockProps & { data: InlineToolData }) {
  const { t } = useTranslation()
  const [copied, setCopied] = React.useState(false)
  const output = inlineOutput(data.output)
  const input = inlineOutput(inlineToolInput(activity))
  // An approval has no result yet; keep its captured command readable when the preview folds away.
  const pendingCommand = activity.status === 'pending' && activity.toolName?.toLowerCase() === 'bash'
    && !output.text && typeof activity.toolInput?.command === 'string'
    ? inlineOutput(activity.toolInput.command).text : ''
  const body = data.kind === 'question' ? <QuestionResult data={data} />
    : data.kind === 'edit' && data.edits?.length ? activity.toolName?.toLowerCase() === 'multiedit'
      ? <MultiEditResult edits={data.edits} /> : <EditResult edits={data.edits} />
    : data.kind === 'write' ? <WriteResult code={output.text} path={data.path} />
    : data.kind === 'files' ? <div className="space-y-1 font-mono text-xs">{output.text.split('\n').map((path, index) =>
      onOpenFile && /^(?:\.?\.?\/|\/|[A-Za-z]:[\\/])/.test(path)
        ? <button key={index} type="button" onClick={() => onOpenFile(path)} className="block max-w-full truncate text-left text-secondary hover:underline">{path}</button>
        : <div key={index} className="whitespace-pre-wrap break-words">{path}</div>)}
    </div>
    : data.kind === 'markdown' ? <Markdown mode="chat" onFileClick={onOpenFile} onUrlClick={onOpenUrl}>{output.text}</Markdown>
    : data.kind === 'read' ? <ReadResult code={output.text} path={data.path} startLine={data.startLine} />
    : data.kind === 'generic' || data.kind === 'mcp' ? <div className="space-y-3 font-mono text-xs">
      {activity.toolName?.startsWith('mcp__') && <div className="text-secondary">Tool: {activity.toolName}</div>}
      {input.text && <div><div className="mb-1 font-sans font-medium text-secondary">Input:</div>
        <pre className="m-0 whitespace-pre-wrap break-words text-secondary">{input.text}</pre></div>}
      {output.text && <div>{input.text && <div className="mb-1 font-sans font-medium text-secondary">{activity.status === 'error' ? 'Error:' : 'Output:'}</div>}
        <pre className={cn('m-0 whitespace-pre-wrap break-words', activity.status === 'error' && 'text-destructive')}>{output.text}</pre></div>}
    </div> : <ToolCode code={stripAnsi(output.text || pendingCommand)} language={data.language} path={data.path} />

  return <div className={cn('group/tool-body relative rounded-md', data.kind !== 'markdown' && data.kind !== 'read' && 'border border-subtle bg-sunken',
    !['markdown', 'read'].includes(data.kind) && activity.toolName?.toLowerCase() !== 'multiedit' && 'p-3')}>
    {output.text && <button type="button" title={t('common.copy')} aria-label={t('common.copy')}
      className={cn('absolute right-1 top-1 z-10 flex size-6 items-center justify-center rounded bg-sunken text-secondary opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/tool-body:opacity-100 group-focus-within/tool-body:opacity-100', data.defaultExpanded && 'opacity-100')}
      onClick={() => { void navigator.clipboard.writeText(data.output).then(() => setCopied(true)).catch(() => {}) }}>
      {copied ? <Check aria-hidden className="size-3" /> : <Copy aria-hidden className="size-3" />}
    </button>}
    <div className={cn('min-w-0 overflow-auto', data.kind === 'mcp' ? 'h-96' : data.kind === 'files' ? 'max-h-64' : 'max-h-[500px]')}>{body}</div>
    {(output.truncated || input.truncated) && <div className="mt-2 text-xs italic text-secondary">Content truncated ({Math.max(data.output.length, inlineToolInput(activity).length).toLocaleString()} chars total)</div>}
  </div>
}

function CollaborationBlock({ activity, sessionId, onOpenDetails, data }: InlineToolBlockProps & { data: CollaborationData }) {
  const label = data.receivers.length === 1 ? data.receivers[0]!.nickname || data.receivers[0]!.id.slice(0, 13)
    : data.receivers.length > 1 ? `${data.receivers.length} agents` : 'agent'
  const active = data.status === 'running'
  return <InlineDisclosure id={activity.id} sessionId={sessionId}
    icon={active ? <Spinner className="size-3.5" /> : data.status === 'error' ? <CircleAlert className="size-3.5 text-destructive" /> : <Bot className="size-3.5" />}
    title={<>{data.title} <span className="font-medium">{label}</span></>} error={data.status === 'error'}
    preview={data.model ? <span title="Requested model">{data.model}</span> : undefined}
    collapsible={Boolean(data.prompt || data.receivers.length)}
    bodyClassName="ml-1.5 space-y-1 border-l border-subtle pl-4 text-xs text-secondary"
    onOpenDetails={onOpenDetails ? () => onOpenDetails(activity) : undefined}>
    {data.prompt && <div className="break-words">{data.prompt.replace(/\s+/g, ' ').slice(0, 160)}{data.prompt.length > 160 ? '…' : ''}</div>}
    {data.receivers.map(receiver => <div key={receiver.id} className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0">{receiver.state === 'errored' ? <CircleAlert className="size-3 text-destructive" />
        : receiver.state === 'running' || receiver.state === 'pendingInit' ? <Spinner className="size-3" /> : <Check className="size-3" />}</span>
      <span className="min-w-0"><span title={receiver.id} className="font-medium text-foreground">{receiver.nickname || receiver.id.slice(0, 13)}</span>
        {receiver.role && !['default', 'low', 'medium', 'high', 'xhigh'].includes(receiver.role) && <span className="ml-1">{receiver.role}</span>}
        {receiver.state && <span>: {receiver.state}</span>}{receiver.message && <span> — {receiver.message.slice(0, 240)}</span>}
      </span>
    </div>)}
  </InlineDisclosure>
}

function InlineToolContent(props: InlineToolBlockProps) {
  const { activity, sessionId, sessionFolderPath, onOpenFile, onOpenDetails } = props
  const { t } = useTranslation()
  const collaboration = collaborationData(activity)
  const data = getInlineToolData(activity, sessionFolderPath)
  const metadata = formatToolDisplay(activity)
  const active = activity.status === 'running' || activity.status === 'pending' || activity.status === 'backgrounded'
  const error = activity.status === 'error'
  const thinking = activity.type === 'thinking'
  const statusOnly = data.kind === 'status' || data.kind === 'image'
    || (data.kind === 'question' && !data.output.startsWith('User responses:') && !error)
  const hasBody = !statusOnly && (Boolean(data.output || data.edits?.length) || Boolean(inlineToolInput(activity)))
  const pathPreview = data.path && onOpenFile ? <button type="button" title={data.path}
    className="cursor-pointer hover:underline" onClick={() => onOpenFile(data.path!)}>{data.preview}</button> : data.preview
  const preview = data.stats ? <span className="inline-flex min-w-0 items-center gap-2"><span className="truncate">{pathPreview}</span>
    {data.stats.additions > 0 && <span className="text-success">+{data.stats.additions}</span>}
    {data.stats.deletions > 0 && <span className="text-destructive">−{data.stats.deletions}</span>}
  </span> : pathPreview
  const icon = active ? <Spinner className="size-3.5" /> : error ? <CircleAlert className="size-3.5 text-destructive" />
    : thinking ? <Brain className="size-3.5" /> : <ToolIcon toolName={activity.toolName} customIcon={metadata.icon} />

  if (collaboration) return <CollaborationBlock {...props} data={collaboration} />
  if (data.kind === 'todo') return <TodoResult data={data} activity={activity} sessionId={sessionId} />

  if (thinking) return <InlineDisclosure id={activity.id} sessionId={sessionId} icon={icon} title={t('chat.modelPicker.thinkingSection')}
    forceExpanded={Boolean((props.openMessageId && (activity.messageId ?? activity.id) === props.openMessageId)
      || (props.searchQuery?.trim() && activity.content?.toLocaleLowerCase().includes(props.searchQuery.trim().toLocaleLowerCase())))}
    preview={<span className="rounded-md bg-sunken px-1 py-0.5 font-sans">{activity.content}</span>} collapsible={Boolean(activity.content)}>
    <div className="text-secondary"><Markdown mode="chat" onFileClick={props.onOpenFile} onUrlClick={props.onOpenUrl}>{activity.content || ''}</Markdown></div>
  </InlineDisclosure>

  return <>
    <InlineDisclosure id={activity.id} sessionId={sessionId} icon={icon} title={data.title} preview={data.kind === 'question' ? <span className="inline-flex rounded-md border border-strong px-2 py-0.5 font-sans text-xs font-medium">{data.preview}</span> : error ? activity.error || data.preview : data.kind === 'status' ? <span className="font-sans">{data.preview}</span> : preview}
      error={error} defaultExpanded={data.defaultExpanded} alwaysShowPreview={Boolean(data.path)} collapsible={hasBody}
      previewInteractive={Boolean(!error && data.path && onOpenFile)}
      onOpenDetails={onOpenDetails ? () => onOpenDetails(activity) : undefined}>
      <InlineToolBody {...props} data={data} />
    </InlineDisclosure>
    {error && activity.error && <div className="my-1 text-sm text-destructive">{activity.error}</div>}
  </>
}

export function InlineToolBlock(props: InlineToolBlockProps) {
  const fallback = typeof props.activity.content === 'string' ? props.activity.content : props.activity.error || props.activity.toolName || ''
  return <ToolResultBoundary key={`${props.activity.id}:${props.activity.status}`}
    fallback={<pre className="max-h-[500px] overflow-auto whitespace-pre-wrap rounded-md border border-subtle bg-sunken p-3 font-mono text-xs">{inlineOutput(fallback).text}</pre>}>
    <InlineToolContent {...props} />
  </ToolResultBoundary>
}
