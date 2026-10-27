import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, MessageSquarePlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { formatGitReviewComments, type GitReviewComment, type GitReviewLine, type GitReviewSnapshot } from '@craft-agent/shared/protocol'

interface Props {
  sessionId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onAddToChat: (text: string) => void
}

export function GitReviewDialog({ sessionId, open, onOpenChange, onAddToChat }: Props) {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = React.useState<GitReviewSnapshot | null>(null)
  const [error, setError] = React.useState<string>()
  const [loading, setLoading] = React.useState(false)
  const [revision, refresh] = React.useReducer(value => value + 1, 0)
  const [selectedPath, setSelectedPath] = React.useState<string>()
  const [comments, setComments] = React.useState<GitReviewComment[]>([])
  const [target, setTarget] = React.useState<{ side: 'old' | 'new'; line: number; excerpt: string }>()
  const [commentText, setCommentText] = React.useState('')
  const pendingDraftRef = React.useRef(false)
  pendingDraftRef.current = comments.length > 0 || !!commentText.trim()
  React.useEffect(() => {
    setComments([]); setTarget(undefined); setCommentText(''); setSelectedPath(undefined); setSnapshot(null)
  }, [sessionId])
  React.useEffect(() => {
    if (!open || pendingDraftRef.current) return
    let cancelled = false
    setLoading(true); setError(undefined)
    window.electronAPI.getGitReview(sessionId).then(next => {
      if (cancelled) return
      setSnapshot(next)
      setSelectedPath(current => next.files.some(file => file.path === current) ? current : next.files[0]?.path)
      setTarget(undefined); setCommentText('')
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, sessionId, revision])
  const file = snapshot?.files.find(entry => entry.path === selectedPath)
  const selectLine = (line: GitReviewLine) => {
    const number = line.newLine ?? line.oldLine
    if (number === undefined) return
    setTarget({ side: line.newLine !== undefined ? 'new' : 'old', line: number, excerpt: line.text })
  }
  const addComment = () => {
    if (!file || !target || !commentText.trim() || comments.length >= 50) return
    setComments(current => [...current, { path: target.side === 'old' ? file.previousPath ?? file.path : file.path, ...target, text: commentText.trim() }])
    setTarget(undefined); setCommentText('')
  }
  const sendToDraft = () => {
    if (!snapshot || !comments.length) return
    onAddToChat(formatGitReviewComments(snapshot, comments))
    setComments([]); onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(90vh,960px)] w-[min(96vw,1440px)] max-w-[96vw] flex-col gap-3 overflow-hidden p-4 sm:max-w-[96vw]">
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>{t('gitReview.title', { defaultValue: 'Review changes' })}</DialogTitle>
          <DialogDescription className="truncate">
            {snapshot ? `${snapshot.branch} · ${snapshot.baseRef} → worktree · ${snapshot.files.length} ${t('gitReview.files', { defaultValue: 'files' })}` : t('gitReview.description', { defaultValue: 'Committed, staged, unstaged and new files in this branch.' })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex shrink-0 items-center justify-between gap-3">
          <Button variant="outline" size="sm" onClick={() => refresh()} disabled={loading || comments.length > 0 || !!commentText.trim()}><RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />{t('common.refresh', { defaultValue: 'Refresh' })}</Button>
          <span className="text-label-sm text-tertiary">{t('gitReview.lineHint', { defaultValue: 'Select a line number to leave a comment.' })}</span>
        </div>
        {error ? <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-label text-destructive">{error}</div> : snapshot && !snapshot.files.length ? <div className="flex flex-1 items-center justify-center text-secondary">{t('gitReview.clean', { defaultValue: 'No changes against the base branch.' })}</div> : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border md:flex-row">
            <div className="max-h-36 shrink-0 overflow-auto border-b border-border md:max-h-none md:w-60 md:border-b-0 md:border-r">
              {snapshot?.files.map(entry => <button type="button" key={entry.path} disabled={!!commentText.trim()} onClick={() => { setSelectedPath(entry.path); setTarget(undefined); setCommentText('') }} className={cn('flex w-full items-center gap-2 px-3 py-2 text-left text-label-sm hover:bg-foreground/5', entry.path === selectedPath && 'bg-foreground/10')}>
                <span className="w-3 shrink-0 font-mono text-tertiary">{entry.status}</span><span className="min-w-0 truncate" title={entry.path}>{entry.path}</span>
              </button>)}
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {file && <>
                <div className="shrink-0 border-b border-border px-3 py-2 font-mono text-label-sm break-all">{file.previousPath ? `${file.previousPath} → ` : ''}{file.path}</div>
                <div className="min-h-0 flex-1 overflow-auto" role="region" aria-label={file.path}>
                  {file.notice && <p className="p-3 text-label text-secondary">{file.notice}</p>}
                  {file.binary && <p className="p-3 text-label text-secondary">{t('gitReview.binary', { defaultValue: 'Binary file changed.' })}</p>}
                  {file.lines.map((line, index) => <div key={index} className={cn('flex min-w-max font-mono text-xs leading-6', line.kind === 'add' && 'bg-success/10', line.kind === 'remove' && 'bg-destructive/10', line.kind === 'hunk' && 'bg-foreground/5 text-tertiary')}>
                    <button type="button" className="sticky left-0 flex w-24 shrink-0 justify-end gap-3 border-r border-border bg-background/90 px-2 text-tertiary hover:text-foreground disabled:pointer-events-none" disabled={(line.oldLine === undefined && line.newLine === undefined) || !!commentText.trim()} onClick={() => selectLine(line)} aria-label={`${t('gitReview.commentLine', { defaultValue: 'Comment on line' })} ${line.newLine ?? line.oldLine ?? ''}`}>
                      <span className="w-8 text-right">{line.oldLine}</span><span className="w-8 text-right">{line.newLine}</span>
                    </button><span className="w-5 shrink-0 select-none text-center text-tertiary">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ''}</span><code className="whitespace-pre pr-4">{line.text || ' '}</code>
                  </div>)}
                  {file.truncated && <p className="p-3 text-label text-secondary">{t('gitReview.truncatedFile', { defaultValue: 'This preview is limited. Open the file to inspect the remaining content.' })}</p>}
                </div>
                {target && <div className="shrink-0 space-y-2 border-t border-border p-3">
                  <div className="flex items-center justify-between text-label-sm text-secondary"><span>{file.path}:{target.line} · {target.side}</span><button type="button" onClick={() => { setTarget(undefined); setCommentText('') }} aria-label={t('common.cancel')}><X className="size-4" /></button></div>
                  <Textarea value={commentText} onChange={event => setCommentText(event.target.value)} placeholder={t('gitReview.commentPlaceholder', { defaultValue: 'What should change on this line?' })} maxLength={4_000} />
                  <Button size="sm" onClick={addComment} disabled={!commentText.trim() || comments.length >= 50}>{t('gitReview.addComment', { defaultValue: 'Add comment' })}</Button>
                </div>}
              </>}
            </div>
          </div>
        )}
        {snapshot?.truncated && <p className="shrink-0 text-label-sm text-secondary">{t('gitReview.limited', { defaultValue: 'Large review: some previews are limited.' })}{snapshot.omittedFiles ? ` ${snapshot.omittedFiles} ${t('gitReview.omittedFiles', { defaultValue: 'additional files omitted.' })}` : ''}</p>}
        {comments.length > 0 && <div className="max-h-36 shrink-0 space-y-2 overflow-auto rounded-lg border border-border p-2">
          {comments.map((comment, index) => <div key={index} className="flex items-start gap-2 text-label-sm">
            <div className="min-w-0 flex-1"><span className="font-mono text-tertiary break-all">{comment.path}:{comment.line} · {comment.side}</span><p className="whitespace-pre-wrap break-words">{comment.text}</p></div>
            <button type="button" onClick={() => setComments(current => current.filter((_, i) => i !== index))} aria-label={t('gitReview.removeComment', { defaultValue: 'Remove comment' })}><X className="size-4" /></button>
          </div>)}
        </div>}
        <div className="flex shrink-0 items-center justify-between gap-2">
          <span className="text-label-sm text-secondary">{comments.length} {t('gitReview.comments', { defaultValue: 'comments' })}</span>
          <Button onClick={sendToDraft} disabled={!comments.length || !snapshot || loading}><MessageSquarePlus className="size-4" />{t('gitReview.addToChat', { defaultValue: 'Add comments to chat' })}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
