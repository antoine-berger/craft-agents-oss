import * as React from 'react'
import { History, Loader2, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionCheckpointList, SessionCheckpointRestoreResult, SessionCheckpointSummary } from '@craft-agent/shared/protocol'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'

interface SessionCheckpointControlProps {
  sessionId: string
  disabled?: boolean
  listCheckpoints: () => Promise<SessionCheckpointList>
  restoreCheckpoint: (checkpointId: string) => Promise<SessionCheckpointRestoreResult>
  /** Render a short user-message label without exposing backend file paths. */
  getTurnLabel?: (userMessageId: string) => string | undefined
  onRestored?: (result: SessionCheckpointRestoreResult) => void
  requestedUserMessageId?: string
  requestedOpen?: boolean
  showTrigger?: boolean
  onRequestHandled?: () => void
}

/** Self-contained header control. The shell supplies typed RPC callbacks and session refresh. */
export function SessionCheckpointControl({ sessionId, disabled, listCheckpoints, restoreCheckpoint, getTurnLabel, onRestored, requestedUserMessageId, requestedOpen, showTrigger = true, onRequestHandled }: SessionCheckpointControlProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [list, setList] = React.useState<SessionCheckpointList>()
  const [selected, setSelected] = React.useState<SessionCheckpointSummary>()
  const [loading, setLoading] = React.useState(false)
  const [restoring, setRestoring] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const loadRef = React.useRef(listCheckpoints)
  loadRef.current = listCheckpoints

  React.useEffect(() => {
    if (requestedOpen || requestedUserMessageId) setOpen(true)
  }, [requestedOpen, requestedUserMessageId])

  React.useEffect(() => {
    setList(undefined); setSelected(undefined); setError(undefined)
  }, [sessionId])

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true); setSelected(undefined); setError(undefined)
    loadRef.current().then(value => {
      if (cancelled) return
      setList(value)
      if (requestedUserMessageId) {
        const target = value.checkpoints.find(checkpoint => checkpoint.kind === 'turn' && checkpoint.userMessageId === requestedUserMessageId)
        setSelected(target)
        if (!target) setError(t('checkpoints.missingTurn', { defaultValue: 'No saved checkpoint exists after this reply. Nothing has been changed.' }))
      }
    }, cause => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, sessionId, requestedUserMessageId, t])

  const matchesRequest = !requestedUserMessageId || (selected?.kind === 'turn' && selected.userMessageId === requestedUserMessageId)
  const confirmRestore = async () => {
    if (!selected || !matchesRequest || disabled || restoring) return
    setRestoring(true); setError(undefined)
    try {
      const result = await restoreCheckpoint(selected.id)
      onRestored?.(result)
      setOpen(false)
      onRequestHandled?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setRestoring(false) }
  }
  const title = requestedUserMessageId
    ? t('checkpoints.returnHere', { defaultValue: 'Restore to this reply' })
    : t('checkpoints.title', { defaultValue: 'Restore a checkpoint' })
  const label = (checkpoint: SessionCheckpointSummary) => checkpoint.kind === 'recovery'
    ? t('checkpoints.recovery', { defaultValue: 'Before an earlier restore' })
    : checkpoint.userMessageId && getTurnLabel?.(checkpoint.userMessageId)
      || t('checkpoints.turn', { defaultValue: 'Before this message' })

  return <>
    {showTrigger && <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" title={title} aria-label={title} onClick={() => setOpen(true)}>
      <History className="size-4" />
    </Button>}
    <Dialog open={open} onOpenChange={value => { if (!restoring) { setOpen(value); if (!value) onRequestHandled?.() } }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{requestedUserMessageId
            ? t('checkpoints.keepReply', { defaultValue: 'Keep this reply and restore the files to this point. Later conversation and code changes are removed, with a recoverable backup of your current state.' })
            : t('checkpoints.description', { defaultValue: 'Return the files and conversation to an earlier turn. Your current state is backed up before anything changes.' })}</DialogDescription>
        </DialogHeader>
        {loading ? <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('common.loading', { defaultValue: 'Loading…' })}</div>
          : list && !list.supported ? <p className="text-sm text-muted-foreground">{list.reason}</p>
            : !list?.checkpoints.length && !error ? <p className="py-4 text-sm text-muted-foreground">{t('checkpoints.empty', { defaultValue: 'No checkpoints yet. A snapshot is captured before each new turn in this session-owned worktree.' })}</p>
              : requestedUserMessageId ? null : <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-1">
                {list?.checkpoints.map(checkpoint => <button type="button" key={checkpoint.id} disabled={restoring || disabled}
                  aria-pressed={selected?.id === checkpoint.id}
                  onClick={() => setSelected(checkpoint)}
                  className={`flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm disabled:opacity-50 ${selected?.id === checkpoint.id ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'}`}>
                  <RotateCcw className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0"><span className="block truncate">{label(checkpoint)}</span><span className="block text-xs text-muted-foreground">{new Date(checkpoint.createdAt).toLocaleString()}</span></span>
                </button>)}
              </div>}
        {disabled && <p className="text-sm text-muted-foreground">{t('checkpoints.stopFirst', { defaultValue: 'Stop running agents and background tasks before restoring.' })}</p>}
        {selected && <div className="rounded-lg bg-muted p-3 text-sm">
          <p className="font-medium">{requestedUserMessageId ? title : label(selected)}</p>
          <p className="mt-1 text-muted-foreground">{t('checkpoints.confirmation', { defaultValue: 'This also restores the local branch and staged changes. Newer files, commits and conversation remain in a recoverable backup. Ignored files are kept.' })}</p>
        </div>}
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => { setOpen(false); onRequestHandled?.() }} disabled={restoring}>{t('common.cancel', { defaultValue: 'Cancel' })}</Button>
          <Button onClick={() => void confirmRestore()} disabled={!selected || !matchesRequest || restoring || disabled}>
            {restoring && <Loader2 className="mr-2 size-4 animate-spin" />}{t('checkpoints.restore', { defaultValue: 'Restore with backup' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
