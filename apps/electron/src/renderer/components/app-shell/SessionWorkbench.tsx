import * as React from 'react'
import { FolderTree, TerminalSquare, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

const Files = React.lazy(() => import('../worktree-files/WorktreeFilesPanel').then(module => ({ default: module.WorktreeFilesPanel })))
const Terminal = React.lazy(() => import('../terminal/SessionTerminalPanel').then(module => ({ default: module.SessionTerminalPanel })))

interface Props {
  sessionId: string
  archived?: boolean
  compact?: boolean
  onClose(): void
}

/** Optional tools share the session checkout; the ordinary conversation remains the main surface. */
export function SessionWorkbench({ sessionId, archived, compact, onClose }: Props) {
  const [view, setView] = React.useState<'files' | 'terminal'>('files')
  const panel = React.useRef<HTMLElement>(null)
  const [overlay, setOverlay] = React.useState(true)
  React.useLayoutEffect(() => {
    const parent = panel.current?.parentElement
    if (!parent) return
    const opener = document.activeElement
    const measure = () => setOverlay(parent.clientWidth < 800)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    panel.current?.querySelector<HTMLElement>('button')?.focus()
    return () => {
      observer.disconnect()
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])
  return <aside ref={panel} aria-label="Worktree tools" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
  }} className={cn(
    'flex min-h-0 shrink-0 flex-col border-l border-border bg-background',
    compact || overlay ? 'absolute inset-0 z-20' : 'w-[min(44%,560px)] min-w-80',
  )}>
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
      <Button variant="ghost" size="sm" aria-pressed={view === 'files'} onClick={() => setView('files')}><FolderTree className="size-3.5" />Files</Button>
      <Button variant="ghost" size="sm" aria-pressed={view === 'terminal'} disabled={archived} onClick={() => setView('terminal')}><TerminalSquare className="size-3.5" />Terminal</Button>
      <Button variant="ghost" size="icon" className="ml-auto size-7" aria-label="Hide worktree tools" title="Hide · ⌘⇧B" onClick={onClose}><X className="size-4" /></Button>
    </div>
    <React.Suspense fallback={<p role="status" className="p-3 text-label-sm text-secondary">Loading…</p>}>
      {view === 'files' || archived
        ? <Files key={sessionId} sessionId={sessionId} api={window.electronAPI} readOnly={archived} className="min-h-0 flex-1" />
        : <Terminal key={sessionId} sessionId={sessionId} api={window.electronAPI} onHide={onClose} />}
    </React.Suspense>
  </aside>
}
