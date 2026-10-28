import * as React from 'react'
import { ArrowLeft, File, Folder, Pencil, RefreshCw, Save, Undo2 } from 'lucide-react'
import { ShikiCodeViewer } from '@craft-agent/ui'
import type { WorktreeDirectory, WorktreeFilesAPI, WorktreeTextFile } from '../../../../../../packages/shared/src/protocol/worktree-files'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface Props {
  sessionId: string
  api: WorktreeFilesAPI
  readOnly?: boolean
  initialPath?: string
  initialLine?: number
  onDirtyChange?: (dirty: boolean) => void
  className?: string
}

// Closing a tool panel must not silently discard a draft. Saved/cancelled drafts leave this map.
const drafts = new Map<string, { base: WorktreeTextFile; content: string }>()

function fileLineEnding(content: string): string | null {
  const endings = new Set(content.match(/\r\n|\r|\n/g) ?? [])
  return endings.size > 1 ? null : [...endings][0] ?? '\n'
}

export function WorktreeFilesPanel({ sessionId, api, readOnly = false, initialPath, initialLine = 1, onDirtyChange, className }: Props) {
  const [directory, setDirectory] = React.useState<WorktreeDirectory | null>(null)
  const [file, setFile] = React.useState<WorktreeTextFile | null>(null)
  const [draft, setDraft] = React.useState('')
  const [editing, setEditing] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [location, setLocation] = React.useState('')
  const [line, setLine] = React.useState(initialLine)
  const request = React.useRef(0)
  const editor = React.useRef<HTMLTextAreaElement>(null)
  const code = React.useRef<HTMLDivElement>(null)
  const lineRef = React.useRef(line)
  lineRef.current = line
  const currentSession = React.useRef(sessionId)
  currentSession.current = sessionId
  const dirty = !!file && draft !== file.content
  const mixedLineEndings = !!file && fileLineEnding(file.content) === null

  React.useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])

  const loadDirectory = React.useCallback(async (path = '') => {
    const generation = ++request.current
    setLoading(true); setError(null)
    try {
      const next = await api.getWorktreeFiles(sessionId, path)
      if (generation !== request.current) return
      setDirectory(next); setFile(null); setDraft(''); setEditing(false); setLocation(path)
    } catch (reason) {
      if (generation === request.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally { if (generation === request.current) setLoading(false) }
  }, [api, sessionId])

  const openFile = React.useCallback(async (path: string, targetLine = 1, restoreDraft = true) => {
    const generation = ++request.current
    setLoading(true); setError(null)
    try {
      const next = await api.readWorktreeFile(sessionId, path)
      if (generation !== request.current) return
      const savedDraft = restoreDraft ? drafts.get(`${sessionId}\0${path}`) : undefined
      setFile(savedDraft?.base ?? next); setDraft(savedDraft?.content ?? next.content)
      setEditing(!!savedDraft); setLocation(path); setLine(Math.max(1, targetLine))
      if (savedDraft && savedDraft.base.version !== next.version) setError('This file changed since your draft. Copy your draft before reloading the file.')
    } catch (reason) {
      if (generation === request.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally { if (generation === request.current) setLoading(false) }
  }, [api, sessionId])

  React.useEffect(() => {
    setDirectory(null); setFile(null); setDraft(''); setEditing(false); setSaving(false)
    if (initialPath) void openFile(initialPath, initialLine)
    else void loadDirectory()
    return () => { request.current++ }
  }, [sessionId, initialPath, initialLine, loadDirectory, openFile])

  function updateDraft(content: string) {
    if (!file) return
    const lineEnding = fileLineEnding(file.content)
    if (lineEnding === null) return
    content = content.replace(/\r\n|\r/g, '\n').replace(/\n/g, lineEnding)
    setDraft(content)
    const key = `${sessionId}\0${file.path}`
    if (content === file.content) drafts.delete(key)
    else drafts.set(key, { base: file, content })
  }

  async function save() {
    if (!file || readOnly || !dirty || saving) return
    const savingSession = sessionId
    const savingGeneration = request.current
    const savingFile = file
    const content = draft
    setSaving(true); setError(null)
    try {
      const next = await api.writeWorktreeFile(savingSession, { path: savingFile.path, content, expectedVersion: savingFile.version })
      const savedDraftKey = `${savingSession}\0${savingFile.path}`
      const savedDraft = drafts.get(savedDraftKey)
      if (savedDraft?.base.version === savingFile.version && savedDraft.content === content) drafts.delete(savedDraftKey)
      if (currentSession.current !== savingSession || request.current !== savingGeneration) return
      setFile(next); setDraft(next.content); setEditing(false)
    } catch (reason) {
      if (currentSession.current === savingSession && request.current === savingGeneration) setError(reason instanceof Error ? reason.message : String(reason))
    } finally { if (currentSession.current === savingSession && request.current === savingGeneration) setSaving(false) }
  }

  function discard() {
    if (!file) return
    drafts.delete(`${sessionId}\0${file.path}`)
    setDraft(file.content); setEditing(false); setError(null)
  }

  const revealCodeLine = React.useCallback(() => {
    const scroll = code.current?.firstElementChild as HTMLElement | null
    if (scroll) scroll.scrollTop = Math.max(0, (lineRef.current - 3) * 21)
  }, [])

  function revealLine() {
    if (editing && editor.current) {
      const offset = editor.current.value.split('\n').slice(0, line - 1).reduce((total, value) => total + value.length + 1, 0)
      editor.current.focus(); editor.current.setSelectionRange(offset, offset)
      editor.current.scrollTop = Math.max(0, (line - 3) * 21)
    } else {
      revealCodeLine()
    }
  }

  const parentPath = directory?.path.split('/').slice(0, -1).join('/') ?? ''
  return <section className={cn('flex h-full min-h-0 flex-col bg-background text-foreground', className)} aria-label="Worktree files">
    <div className="flex shrink-0 items-center gap-1 border-b border-border p-2">
      <Button variant="ghost" size="icon-sm" aria-label="Parent directory" disabled={dirty || loading || saving || (!file && !directory?.path)} onClick={() => void loadDirectory(file ? file.path.split('/').slice(0, -1).join('/') : parentPath)}><ArrowLeft className="size-4" /></Button>
      <form className="min-w-0 flex-1" onSubmit={event => { event.preventDefault(); if (!dirty && location.trim()) void openFile(location.trim()) }}>
        <input aria-label="Open worktree file by path" className="w-full rounded bg-transparent px-1 py-1 font-mono text-xs outline-none focus:ring-1 focus:ring-ring" value={location} onChange={event => setLocation(event.target.value)} disabled={dirty || saving} placeholder={directory?.rootName ?? 'File path'} />
      </form>
      <Button variant="ghost" size="icon-sm" aria-label="Refresh files" disabled={dirty || loading || saving} onClick={() => file ? void openFile(file.path, line, false) : void loadDirectory(directory?.path)}><RefreshCw className={cn('size-4', loading && 'animate-spin')} /></Button>
    </div>
    {error && <p role="alert" className="shrink-0 border-b border-border bg-destructive/10 p-3 text-xs text-destructive">{error}</p>}
    {file ? <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>{file.path}{dirty ? ' •' : ''}</span>
        <label className="flex items-center gap-1 text-secondary">Line<input type="number" min={1} max={draft.split('\n').length} aria-label="Line number" className="w-14 rounded border border-border bg-transparent px-1" value={line} onChange={event => setLine(Math.max(1, Number(event.target.value) || 1))} onKeyDown={event => { if (event.key === 'Enter') revealLine() }} /></label>
        <Button variant="ghost" size="sm" onClick={revealLine}>Go</Button>
        {editing ? <>
          <Button variant="ghost" size="icon-sm" aria-label="Discard file edits" disabled={saving} onClick={discard}><Undo2 className="size-4" /></Button>
          <Button variant="primary" size="sm" disabled={saving || readOnly || !dirty} onClick={() => void save()}><Save className="size-3.5" />{saving ? 'Saving…' : 'Save'}</Button>
        </> : <Button variant="ghost" size="sm" disabled={readOnly || mixedLineEndings} onClick={() => setEditing(true)}><Pencil className="size-3.5" />Edit</Button>}
      </div>
      {mixedLineEndings && <p className="shrink-0 border-b border-border px-3 py-2 text-xs text-secondary">Mixed line endings: preview only, so this editor preserves the file unchanged.</p>}
      {editing ? <textarea ref={editor} aria-label={`Edit ${file.path}`} className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-[13px] leading-[21px] outline-none" spellCheck={false} wrap="off" value={draft} readOnly={readOnly || saving} onChange={event => updateDraft(event.target.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); void save() } }} />
        : <div ref={code} className="min-h-0 flex-1 overflow-hidden"><ShikiCodeViewer code={file.content} filePath={file.path} theme={document.documentElement.classList.contains('dark') ? 'dark' : 'light'} onReady={revealCodeLine} /></div>}
    </> : <div className="min-h-0 flex-1 overflow-auto p-1" aria-label="Worktree directory">
      {!loading && !directory?.entries.length && <p className="p-3 text-xs text-secondary">No files in this directory.</p>}
      {directory?.entries.map(entry => <button key={entry.path} className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-fill-hover disabled:text-disabled" disabled={loading || entry.kind === 'symlink'} title={entry.kind === 'symlink' ? 'Symbolic links are not opened' : entry.path} onClick={() => entry.kind === 'directory' ? void loadDirectory(entry.path) : void openFile(entry.path)}>
        {entry.kind === 'directory' ? <Folder className="size-3.5 shrink-0 text-secondary" /> : <File className="size-3.5 shrink-0 text-secondary" />}<span className="truncate">{entry.name}</span>
      </button>)}
      {directory?.truncated && <p className="p-3 text-xs text-secondary">Showing the first 1,000 entries. Open a file by path above.</p>}
    </div>}
  </section>
}
