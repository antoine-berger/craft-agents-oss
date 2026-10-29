import * as React from 'react'
import { ArrowUp, Check, Pause, Pencil, Play, X } from 'lucide-react'
import { toast } from 'sonner'
import type { Message } from '../../../../shared/types'
import type { SessionCommand } from '@craft-agent/shared/protocol'

type QueueCommand = Extract<SessionCommand, { type: 'queueMessage' }>

/** The server owns delivery; drafts here never replace the main composer draft. */
export function QueuedMessages({ sessionId, messages, paused, disabled }: {
  sessionId: string
  messages: Message[]
  paused: boolean
  disabled: boolean
}) {
  const [editing, setEditing] = React.useState<string | null>(null)
  const [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const editor = React.useRef<HTMLTextAreaElement>(null)
  const list = React.useRef<HTMLOListElement>(null)
  const currentSession = React.useRef(sessionId)
  currentSession.current = sessionId
  const busyRef = React.useRef(false)
  const pauseBeforeEdit = React.useRef(false)
  React.useEffect(() => {
    const focus = (event: Event) => {
      if ((event as CustomEvent).detail?.sessionId === sessionId) (list.current?.lastElementChild as HTMLElement | null)?.focus()
    }
    window.addEventListener('craft:focus-queue', focus)
    return () => window.removeEventListener('craft:focus-queue', focus)
  }, [sessionId])
  React.useEffect(() => { setEditing(null); setText(''); setBusy(false); busyRef.current = false }, [sessionId])
  React.useEffect(() => { if (editing) editor.current?.focus() }, [editing])
  React.useEffect(() => {
    if (editing && !messages.some(message => message.id === editing)) setEditing(null)
  }, [editing, messages])

  async function command(action: QueueCommand['action'], messageId?: string, nextText?: string): Promise<boolean> {
    if (busyRef.current || disabled) return false
    busyRef.current = true
    setBusy(true)
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'queueMessage', action, messageId, text: nextText })
      return currentSession.current === sessionId
    } catch (error) {
      if (currentSession.current === sessionId) toast.error(error instanceof Error ? error.message : 'Could not update the queue')
      return false
    } finally { if (currentSession.current === sessionId) { busyRef.current = false; setBusy(false) } }
  }

  async function finishEdit(save: boolean) {
    if (save && !await command('edit', editing ?? undefined, text)) return
    setEditing(null)
    if (!pauseBeforeEdit.current) await command('resume')
  }

  async function startEdit(message: Message) {
    const wasPaused = paused
    if (await command('pause', message.id)) { pauseBeforeEdit.current = wasPaused; setText(message.content); setEditing(message.id) }
  }

  if (!messages.length) return null
  return <section aria-label="Message queue" className="mx-auto mb-2 w-full max-w-3xl rounded-xl border border-border/60 bg-background/60 px-3 py-2 text-sm">
    <div className="mb-1 flex items-center justify-between text-xs text-secondary">
      <span>{paused ? 'Queue paused' : 'Queued'} · {messages.length}</span>
      <button type="button" disabled={busy || disabled || !!editing} onClick={() => void command(paused ? 'resume' : 'pause')} aria-label={paused ? 'Resume queue' : 'Pause queue'} className="rounded p-1 hover:bg-foreground/5 disabled:opacity-40">{paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}</button>
    </div>
    <ol ref={list} className="max-h-64 space-y-1 overflow-y-auto">
      {messages.map((message, index) => <li key={message.id} tabIndex={0} onKeyDown={event => {
        if (event.target !== event.currentTarget || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey || editing || busy || disabled || message.isPending) return
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); ((event.key === 'ArrowUp' ? event.currentTarget.previousElementSibling : event.currentTarget.nextElementSibling) as HTMLElement | null)?.focus() }
        if (event.key === 'Enter') { event.preventDefault(); void command('send', message.id) }
        if (event.key === 'e' || event.key === 'E') { event.preventDefault(); void startEdit(message) }
        if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); void command('remove', message.id) }
      }} className="group flex items-start gap-2 rounded-md px-1 py-1 focus-within:bg-foreground/5 hover:bg-foreground/5">
        <span className="pt-1 text-xs tabular-nums text-tertiary">{index + 1}</span>
        {editing === message.id ? <div className="min-w-0 flex-1">
          <textarea ref={editor} value={text} onChange={event => setText(event.target.value)} disabled={busy || disabled} aria-label="Edit queued message" className="min-h-16 w-full resize-y rounded bg-transparent p-1 text-sm outline-none" onKeyDown={event => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Escape') { event.preventDefault(); void finishEdit(false) }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void finishEdit(true) }
          }} />
          {!!message.attachments?.length && <p className="text-xs text-secondary">{message.attachments.length} attachment(s) kept</p>}
          <div className="flex justify-end gap-2 text-xs"><button type="button" disabled={busy || disabled} onClick={() => void finishEdit(false)}>Cancel</button><button type="button" disabled={busy || disabled || (!text.trim() && !message.attachments?.length)} onClick={() => void finishEdit(true)} className="inline-flex items-center gap-1"><Check className="size-3" />Save</button></div>
        </div> : <>
          <button type="button" disabled={busy || disabled || message.isPending || !!editing} className="min-w-0 flex-1 whitespace-pre-wrap break-words py-0.5 text-left text-secondary" onClick={() => void startEdit(message)}>{message.content || `${message.attachments?.length ?? 0} attachment(s)`}</button>
          <div className="flex shrink-0 gap-0.5 text-secondary">
            <button type="button" disabled={busy || disabled || message.isPending || !!editing} aria-label="Edit queued message" title="Edit" className="rounded p-1 hover:bg-foreground/10 disabled:opacity-40" onClick={() => void startEdit(message)}><Pencil className="size-3.5" /></button>
            <button type="button" disabled={busy || disabled || message.isPending || !!editing} aria-label="Send queued message now" title="Send now" className="rounded p-1 hover:bg-foreground/10 disabled:opacity-40" onClick={() => void command('send', message.id)}><ArrowUp className="size-3.5" /></button>
            <button type="button" disabled={busy || disabled || message.isPending || !!editing} aria-label="Remove queued message" title="Remove" className="rounded p-1 hover:bg-foreground/10 disabled:opacity-40" onClick={() => void command('remove', message.id)}><X className="size-3.5" /></button>
          </div>
        </>}
      </li>)}
    </ol>
  </section>
}
