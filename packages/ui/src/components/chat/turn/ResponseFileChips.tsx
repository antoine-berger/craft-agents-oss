import * as React from 'react'
import { FileText, Files } from 'lucide-react'
import { cn } from '../../../lib/utils'

/** Conductor shows at most three files initially; larger sets reveal three more per click. */
export function ResponseFileChips({ paths, onOpenFile }: { paths: string[]; onOpenFile?: (path: string) => void }) {
  const [revealed, setRevealed] = React.useState(0)
  const initialCount = paths.length <= 3 ? paths.length : 2
  const first = paths.slice(0, initialCount)
  const extra = paths.slice(initialCount, initialCount + revealed)
  const remaining = paths.length - first.length - extra.length
  const expanded = revealed > 0
  const chip = (path: string) => <button key={path} type="button" disabled={!onOpenFile} onClick={() => onOpenFile?.(path)} title={path}
    className="inline-flex h-5 min-w-0 max-w-full shrink-0 items-center gap-1 overflow-hidden rounded border border-subtle px-1.5 text-xs leading-none text-secondary enabled:hover:bg-fill-hover">
    <FileText aria-hidden className="size-3 shrink-0"/><span className="truncate">{path.split(/[\\/]/).pop() || path}</span>
  </button>
  return <>
    <div className={cn('min-w-0 max-w-fit flex-1 items-center gap-2 overflow-hidden', expanded ? 'flex @max-[480px]:basis-full @max-[480px]:max-w-none' : 'hidden @[480px]:flex')}>{first.map(chip)}</div>
    <div className={cn('flex min-w-0 flex-wrap items-center gap-2', expanded && 'basis-full')}>
      {extra.map(chip)}
      {(remaining > 0 || !expanded) && <button type="button" onClick={() => setRevealed(value => value + 3)}
        aria-label={remaining ? `Show ${Math.min(3, remaining)} more changed ${Math.min(3, remaining) === 1 ? 'file' : 'files'}` : 'Show changed files'}
        className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded border border-subtle px-1 text-xs leading-none tabular-nums text-secondary hover:bg-fill-hover @[480px]:px-1.5', remaining === 0 && '@[480px]:hidden')}>
        <Files aria-hidden className="size-3"/><span className="@[480px]:hidden">{expanded ? remaining : paths.length}</span><span className="hidden @[480px]:inline">+{remaining} more</span>
      </button>}
    </div>
  </>
}
