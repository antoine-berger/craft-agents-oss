import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, FileText } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import './chat-turn-navigation.css'

export interface ChatOutlineEntry {
  key: string
  label: string
  isPlan: boolean
}

function centerCurrentEntry(element: HTMLButtonElement | null) {
  const parent = element?.parentElement
  if (element && parent) parent.scrollTop = element.offsetTop - (parent.clientHeight - element.offsetHeight) / 2
}

export function ChatTurnNavigation({ entries, activeKey, showScrollToBottom, onNavigate, onScrollToBottom }: {
  entries: ChatOutlineEntry[]
  activeKey?: string
  showScrollToBottom: boolean
  onNavigate: (key: string) => void
  onScrollToBottom: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const hoverTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>()
  React.useEffect(() => () => clearTimeout(hoverTimer.current), [])
  const scheduleOpen = (value: boolean) => {
    clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setOpen(value), value ? 50 : 100)
  }
  const currentIndex = Math.max(0, entries.findLastIndex(entry => entry.key === activeKey))
  const markerStartIndex = Math.max(0, entries.length - 50)

  return <>
    {entries.length > 1 && (
      <div
        className="chat-turn-navigation absolute right-2 top-4 z-40"
        onPointerEnter={() => scheduleOpen(true)}
        onPointerLeave={() => scheduleOpen(false)}
      >
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button" aria-label={t('chat.navigation.contents')} className="rounded p-1 transition-colors hover:bg-sunken">
              <span aria-hidden className="relative flex max-h-[calc(100vh-12rem)] w-7 flex-col gap-1.5 overflow-hidden p-1">
                {entries.slice(markerStartIndex).map((entry, index) => (
                  <span key={entry.key} className={cn(
                    'h-0.5 w-full shrink-0 rounded-full transition-colors',
                    entry.isPlan ? 'bg-[var(--chat-outline-plan)]' : 'bg-muted-foreground/30',
                    index + markerStartIndex === currentIndex && 'bg-foreground',
                  )} />
                ))}
                <span className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t from-paper to-transparent" />
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="left"
            align="start"
            sideOffset={-28}
            className="chat-turn-navigation w-64 overflow-hidden p-2"
            onPointerEnter={() => clearTimeout(hoverTimer.current)}
            onPointerLeave={() => scheduleOpen(false)}
          >
            <div className="flex max-h-80 flex-col gap-0.5 overflow-y-auto overflow-x-hidden">
              {entries.map((entry, index) => (
                <button
                  key={entry.key}
                  ref={index === currentIndex ? centerCurrentEntry : undefined}
                  type="button"
                  onClick={() => { onNavigate(entry.key); setOpen(false) }}
                  className={cn(
                    'inline-flex min-h-7 w-full shrink-0 items-center gap-1.5 truncate rounded px-2 text-left text-[14px] hover:bg-hover',
                    currentIndex === index && 'bg-hover',
                    entry.isPlan && 'text-[var(--chat-outline-plan-text)]',
                  )}
                >
                  {entry.isPlan && <FileText aria-hidden className="size-3 shrink-0" />}
                  <span className="truncate">{entry.label}</span>
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    )}
    {showScrollToBottom && (
      <div className="pointer-events-none absolute inset-x-0 bottom-3 px-4">
        <div className="mx-auto max-w-4xl">
          <button
            type="button"
            aria-label={t('chat.navigation.latest')}
            onClick={onScrollToBottom}
            className="pointer-events-auto inline-flex size-7 items-center justify-center rounded border border-strong bg-paper text-foreground shadow-xs hover:bg-sunken"
          >
            <ArrowDown aria-hidden className="size-3" />
          </button>
        </div>
      </div>
    )}
  </>
}
