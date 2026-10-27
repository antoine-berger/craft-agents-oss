import * as React from 'react'
import { Button } from '@/components/ui/button'
import type { ConductorImportAPI, ConductorChatPreview, ConductorImportBundle } from '../../../../../../packages/shared/src/protocol/conductor-import'

interface Props { workspaceId: string; api: ConductorImportAPI }
/** Explicit, copy-only migration. Listing never imports or starts a session. */
export function ConductorImportPanel({ workspaceId, api }: Props) {
  const [chats, setChats] = React.useState<ConductorChatPreview[]>([])
  const [total, setTotal] = React.useState(0)
  const [cursor, setCursor] = React.useState<number>()
  const [search, setSearch] = React.useState('')
  const [databasePath, setDatabasePath] = React.useState('')
  const [selected, setSelected] = React.useState(new Set<string>())
  const [preview, setPreview] = React.useState<ConductorImportBundle>()
  const [busy, setBusy] = React.useState(false)
  const [progress, setProgress] = React.useState('')
  const [error, setError] = React.useState('')
  const [notes, setNotes] = React.useState<string[]>([])
  const fileInput = React.useRef<HTMLInputElement>(null)
  const cancelled = React.useRef(false)
  const query = React.useRef(0)
  const options = { databasePath: databasePath.trim() || undefined }

  async function load(append = false) {
    const generation = ++query.current
    setBusy(true); setError('')
    try {
      const result = await api.listConductorChats({ ...options, search, limit: 50, cursor: append ? cursor : 0 })
      if (generation !== query.current) return
      setChats(previous => append ? [...previous, ...result.chats] : result.chats)
      setTotal(result.total); setCursor(result.nextCursor); setNotes(result.warnings)
      if (!append) { setSelected(new Set()); setPreview(undefined) }
    } catch (error) { if (generation === query.current) setError(error instanceof Error ? error.message : 'Unable to read Conductor') }
    finally { if (generation === query.current) setBusy(false) }
  }
  React.useEffect(() => { void load(); return () => { query.current++; cancelled.current = true } }, [workspaceId])

  async function inspect(id: string) {
    setBusy(true); setError('')
    try { setPreview(await api.exportConductorChat(id, options)) }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to preview this chat') }
    finally { setBusy(false) }
  }
  async function migrate() {
    if (!selected.size || busy) return
    cancelled.current = false
    setBusy(true); setError(''); setNotes([])
    let imported = 0, skipped = 0, failed = 0, completed = 0
    const warnings = new Set<string>()
    // One bounded chat at a time: no array of all user histories in renderer memory.
    for (const id of selected) {
      if (cancelled.current) break
      setProgress(`${completed + 1} / ${selected.size} chats`)
      try {
        const bundle = preview?.origin.sessionId === id ? preview : await api.exportConductorChat(id, options)
        const result = await api.importConductorChat(workspaceId, bundle)
        result.status === 'imported' ? imported++ : skipped++
        result.warnings.forEach(warning => warnings.add(warning))
        setSelected(previous => { const next = new Set(previous); next.delete(id); return next })
      } catch { failed++; warnings.add('A chat could not be copied. It remains selected and its original is unchanged.') }
      completed++
    }
    setProgress(`${imported} copied · ${skipped} already imported · ${failed} failed${cancelled.current ? ' · stopped' : ''}`)
    setNotes([...warnings].slice(0, 30)); setBusy(false)
  }
  async function openSaved(file: File | undefined) {
    if (!file) return
    setError('')
    try {
      if (file.size > 14 * 1024 * 1024) throw new Error('Saved import exceeds the 14 MB portable import limit.')
      const saved = JSON.parse(await file.text()) as ConductorImportBundle
      if (saved.version !== 1 || saved.origin?.provider !== 'conductor' || typeof saved.origin.sessionId !== 'string' || saved.preview?.id !== saved.origin.sessionId || typeof saved.preview?.title !== 'string' || !Array.isArray(saved.bundle?.session?.messages) || !saved.bundle.session.messages.every(message => message && typeof message.type === 'string' && typeof message.content === 'string') || !Array.isArray(saved.bundle.files) || !saved.bundle.files.every(file => file && typeof file.relativePath === 'string') || !Array.isArray(saved.warnings) || !saved.warnings.every(warning => typeof warning === 'string')) throw new Error('Choose a portable Conductor import JSON file exported by Craft.')
      setPreview(saved); setSelected(new Set([saved.origin.sessionId])); setNotes(saved.warnings || [])
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to open this saved import') }
  }
  function savePreview() {
    if (!preview) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(preview)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'conductor-chat-import.json'; link.click()
    URL.revokeObjectURL(url)
  }
  function toggle(id: string) { setSelected(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next }) }
  return <div className="space-y-4">
    <div>
      <h3 className="text-sm font-medium">Import from Conductor</h3>
      <p className="mt-1 text-xs text-muted-foreground">Copy selected chats into this workspace, grouped by their repository. Your Conductor data stays unchanged. Repeating an import skips identical copies.</p>
      <p className="mt-2 text-xs text-muted-foreground">Cloud chats come from the local cache and may be incomplete. Continuing a chat starts a new agent with its saved history as context; credentials, running processes and Git changes are not copied.</p>
    </div>
    <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" aria-label="Open saved Conductor import" onChange={event => { void openSaved(event.target.files?.[0]); event.target.value = '' }} />
    <button disabled={busy} className="text-xs text-muted-foreground underline underline-offset-2" onClick={() => fileInput.current?.click()}>Open a saved portable import (.json)</button>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Use another Conductor database copy</summary>
      <input aria-label="Conductor database path" value={databasePath} onChange={event => setDatabasePath(event.target.value)} disabled={busy} placeholder="Default: this Mac’s Conductor database" className="mt-2 w-full rounded-md border bg-transparent px-3 py-2" />
    </details>
    <div className="flex gap-2">
      <input aria-label="Search Conductor chats" className="min-w-0 flex-1 rounded-md border bg-transparent px-3 py-2 text-sm" placeholder="Search your Conductor chats" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !busy) void load() }} disabled={busy} />
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}>Search</Button>
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <div className="rounded-lg border">
      <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground"><span>{total} chats · {selected.size} selected</span><button disabled={busy} className="hover:text-foreground disabled:opacity-50" onClick={() => setSelected(new Set(chats.map(chat => chat.id)))}>Select loaded chats</button></div>
      <div className="max-h-72 overflow-auto divide-y">
        {chats.map(chat => <div key={chat.id} className="flex items-center gap-3 px-3 py-2.5">
          <input type="checkbox" aria-label={`Select ${chat.title}`} checked={selected.has(chat.id)} disabled={busy} onChange={() => toggle(chat.id)} />
          <button className="min-w-0 flex-1 text-left disabled:opacity-60" disabled={busy} onClick={() => void inspect(chat.id)}>
            <div className="truncate text-sm">{chat.title}</div><div className="truncate text-xs text-muted-foreground">{[chat.repositoryName, chat.workspaceName, chat.archived ? 'Archived' : '', chat.hidden ? 'Hidden' : '', chat.partial ? 'Cloud cache' : ''].filter(Boolean).join(' · ')}</div>
          </button>
          <span className="shrink-0 text-xs text-muted-foreground">{chat.updatedAt ? new Date(chat.updatedAt).toLocaleDateString() : ''}</span>
        </div>)}
        {!chats.length && <p className="p-4 text-xs text-muted-foreground">{busy ? 'Reading the local chat list…' : 'No Conductor chats found.'}</p>}
      </div>
      {cursor !== undefined && <Button variant="ghost" size="sm" disabled={busy} className="w-full" onClick={() => void load(true)}>Load more</Button>}
    </div>
    {preview && <div className="rounded-lg border p-3 text-xs space-y-2">
      <div className="flex justify-between gap-3"><span className="font-medium">{preview.preview.title}</span><button disabled={busy} className="shrink-0 text-muted-foreground underline" onClick={savePreview}>Save portable copy</button></div>
      <p>{preview.bundle.session.messages.length} history entries · {preview.bundle.files.filter(file => file.relativePath.startsWith('attachments/')).length} attachments · {preview.preview.partial ? 'Cloud cache may be incomplete' : 'Local history'}</p>
      <p className="whitespace-pre-wrap max-h-32 overflow-auto text-muted-foreground">{preview.bundle.session.messages.find(message => message.type === 'user')?.content.slice(0, 800) || 'No materialized user message in this cache.'}</p>
      {preview.warnings.map((warning, index) => <p key={index} className="text-muted-foreground">{warning}</p>)}
    </div>}
    <div className="flex items-center gap-3"><Button size="sm" disabled={busy || !selected.size} onClick={() => void migrate()}>Copy {selected.size || 'selected'} chats</Button>{busy && progress && <Button variant="ghost" size="sm" onClick={() => { cancelled.current = true }}>Stop after this chat</Button>}<span role="status" className="text-xs text-muted-foreground">{progress}</span></div>
    {notes.length > 0 && <div className="space-y-1 text-xs text-muted-foreground">{notes.map((note, index) => <p key={index}>{note}</p>)}</div>}
  </div>
}
