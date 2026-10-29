import * as React from 'react'
import { useSetAtom } from 'jotai'
import { CheckCircle2, ChevronLeft, CircleAlert, CirclePause } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Spinner } from '@craft-agent/ui'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { backgroundTasksAtomFamily } from '@/atoms/sessions'
import { BackgroundTaskCard, formatElapsed, useBackgroundTaskStatus } from './BackgroundTaskChip'
import { advanceBackgroundTaskChips } from './background-task-chip-state'
import { summarizeBackgroundTasks } from './background-task-summary'
import type { ActiveTasksBarProps, BackgroundTask } from './ActiveTasksBar'

function BackgroundTaskListItem({ task, onSelect }: { task: BackgroundTask; onSelect: () => void }) {
  const status = useBackgroundTaskStatus(task)
  return <button type="button" className="flex w-full items-center justify-between gap-3 rounded-sm px-2 py-2 text-left text-[12px] hover:bg-fill-hover" onClick={onSelect}>
    <span className="min-w-0 truncate">{task.intent?.trim() || task.id}</span>
    <span className="shrink-0 text-secondary">{status}</span>
  </button>
}

/** One quiet waiting line; the existing task cards retain output and lifecycle controls. */
export function BackgroundTaskStrip({ tasks, sessionId, onStopTask, onDismissTask, onOpenTaskOutput }: ActiveTasksBarProps) {
  const { t } = useTranslation()
  const [popover, setPopover] = React.useState({ sessionId, open: false })
  const open = popover.sessionId === sessionId && popover.open
  const setOpen = (next: boolean) => setPopover({ sessionId, open: next })
  const [selection, setSelection] = React.useState<{ sessionId: string; taskId: string } | null>(null)
  const selected = selection?.sessionId === sessionId ? tasks.find(task => task.id === selection.taskId) : undefined
  const selectedId = React.useRef<string | undefined>(undefined)
  selectedId.current = open ? selected?.id : undefined
  const setTasks = useSetAtom(backgroundTasksAtomFamily(sessionId))
  const [now, setNow] = React.useState(Date.now)

  React.useEffect(() => {
    if (tasks.length === 0) {
      setPopover(previous => previous.open ? { sessionId, open: false } : previous)
      return
    }
    const timer = setInterval(() => {
      const time = Date.now()
      setNow(time)
      setTasks(previous => advanceBackgroundTaskChips(previous, time, selectedId.current))
    }, 1000)
    return () => clearInterval(timer)
  }, [sessionId, setTasks, tasks.length])

  const summary = summarizeBackgroundTasks(tasks, now)
  if (!summary) return null
  const stopped = tasks.some(task => task.status === 'stopped')
  const warning = tasks.some(task => task.status === 'failed' || task.status === 'orphaned' || task.status === 'stale')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" data-slot="background-tasks" data-background-state={summary.running ? 'running' : summary.pending ? 'unknown' : 'settled'} aria-label={summary.label}
          title={tasks.map(task => task.intent?.trim() || task.id).join('\n')}
          className="mb-2 flex max-w-full items-center gap-3 rounded-sm py-1 text-left text-[12px] leading-4 text-secondary hover:text-foreground">
          {summary.running ? <Spinner className="shrink-0 text-[12px]" /> : warning ? <CircleAlert aria-hidden className="size-3 shrink-0" /> : stopped ? <CirclePause aria-hidden className="size-3 shrink-0" /> : <CheckCircle2 aria-hidden className="size-3 shrink-0" />}
          <span className="min-w-0 truncate">{summary.label}</span>
          <span className="shrink-0 font-mono tracking-wider">{formatElapsed(summary.elapsed)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-[360px] max-w-[calc(100vw-24px)] p-0" tabIndex={-1}
        onOpenAutoFocus={event => { event.preventDefault(); (event.currentTarget as HTMLElement | null)?.focus() }}>
        {selected ? <>
          <button type="button" className="flex items-center gap-1 px-3 py-2 text-[12px] text-secondary hover:text-foreground"
            onClick={() => setSelection(null)}><ChevronLeft aria-hidden className="size-3" />{t('common.back')}</button>
          <BackgroundTaskCard key={`${sessionId}:${selected.id}`} task={selected} sessionId={sessionId}
            onStop={task => onStopTask?.(task)} onDismiss={task => { onDismissTask?.(task); setSelection(null) }}
            onOpenOutput={onOpenTaskOutput} onClose={() => setOpen(false)} />
        </> : <div className="max-h-72 overflow-y-auto p-1">
          {tasks.map(task => <BackgroundTaskListItem key={task.id} task={task}
            onSelect={() => setSelection({ sessionId, taskId: task.id })} />)}
        </div>}
      </PopoverContent>
    </Popover>
  )
}
