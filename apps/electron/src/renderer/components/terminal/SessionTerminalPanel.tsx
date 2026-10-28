import { useEffect, useRef, useState } from 'react'
import { Square, RotateCw, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SessionTerminalAPI, SessionTerminalEvent, SessionTerminalSnapshot } from '@craft-agent/shared/protocol'
import { TerminalStream } from './terminal-stream'
import '@xterm/xterm/css/xterm.css'

interface Props {
  sessionId: string
  api: SessionTerminalAPI
  onHide(): void
}

/** Hiding detaches the viewer; Stop ends the server-side shell and all its jobs. */
export function SessionTerminalPanel({ sessionId, api, onHide }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'connecting' | 'running' | 'exited'>('connecting')
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const terminalId = useRef<string>()
  const stop = async () => {
    if (!terminalId.current) return
    try { await api.closeSessionTerminal(sessionId, terminalId.current); terminalId.current = undefined; setStatus('exited') }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }

  const restart = async () => {
    await stop()
    setAttempt(value => value + 1)
  }

  useEffect(() => {
    if (!container.current) return
    let disposed = false
    let pending: SessionTerminalEvent[] = []
    let opening = false
    let ready = false
    let outputBytes = 0
    terminalId.current = undefined
    setStatus('connecting'); setError(undefined)
    const terminal = new Terminal({
      cursorBlink: true, scrollback: 5_000, fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      allowTransparency: true,
      theme: { background: 'transparent', foreground: getComputedStyle(container.current).color, cursor: getComputedStyle(container.current).color },
      allowProposedApi: false,
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container.current)
    fit.fit()
    const stream = new TerminalStream((data, reset) => { if (reset) terminal.reset(); terminal.write(data) })
    const applySnapshot = (snapshot: SessionTerminalSnapshot) => {
      stream.snapshot(snapshot)
      terminalId.current = snapshot.id
      terminal.options.disableStdin = snapshot.status !== 'running'
      setStatus(snapshot.status)
    }
    const applyEvent = (event: SessionTerminalEvent) => {
      const applied = stream.event(event)
      if (applied === 'gap') { void connect(); return }
      if (applied !== 'applied') return
      if (event.type === 'snapshot') {
        terminal.options.disableStdin = event.snapshot.status !== 'running'
        setStatus(event.snapshot.status)
      }
    }
    const connect = async () => {
      if (opening || disposed) return
      opening = true; ready = false; pending = []; outputBytes = 0
      setError(undefined)
      try {
        const snapshot = await api.openSessionTerminal(sessionId, { cols: terminal.cols, rows: terminal.rows })
        if (disposed) { void api.detachSessionTerminal(sessionId).catch(() => {}); return }
        applySnapshot(snapshot)
        ready = true
        for (const event of pending) applyEvent(event)
        pending = []
        terminal.focus()
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason))
      } finally { opening = false }
    }
    const unsubscribe = api.onSessionTerminalChanged(event => {
      const id = event.type === 'snapshot' ? event.snapshot.sessionId : event.sessionId
      if (id !== sessionId || disposed) return
      if (!ready) {
        outputBytes += event.type === 'snapshot' ? event.snapshot.output.length : event.data.length
        // Re-open returns the complete bounded server snapshot if events outpace the initial RPC.
        if (outputBytes < 512 * 1024) pending.push(event)
        return
      }
      applyEvent(event)
    })
    const input = terminal.onData(data => {
      const id = terminalId.current
      if (id) void api.writeSessionTerminal(sessionId, id, data).catch(reason => { if (!disposed) setError(String(reason instanceof Error ? reason.message : reason)) })
    })
    const resize = new ResizeObserver(() => {
      fit.fit()
      const id = terminalId.current
      if (id) void api.resizeSessionTerminal(sessionId, id, { cols: terminal.cols, rows: terminal.rows }).catch(() => {})
    })
    resize.observe(container.current)
    const reconnect = api.onReconnected(() => { void connect() })
    void connect()
    return () => {
      disposed = true
      reconnect(); unsubscribe(); input.dispose(); resize.disconnect(); terminal.dispose()
      void api.detachSessionTerminal(sessionId).catch(() => {})
    }
  }, [sessionId, api, attempt])

  return <section className="session-terminal flex h-full min-h-0 flex-1 flex-col bg-background" aria-label="Session terminal">
    <header className="flex h-9 shrink-0 items-center gap-2 px-3 text-xs text-secondary">
      <span className="flex-1">Terminal{status === 'connecting' ? ' · Connecting…' : status === 'exited' ? ' · Stopped' : ''}</span>
      {status === 'exited' ? <button type="button" onClick={() => void restart()} title="Open another terminal" aria-label="Open another terminal"><RotateCw className="size-3.5" /></button>
        : <button type="button" onClick={() => void stop()} disabled={status !== 'running'} title="Stop terminal" aria-label="Stop terminal"><Square className="size-3.5" /></button>}
      <button type="button" onClick={onHide} title="Hide terminal" aria-label="Hide terminal"><X className="size-3.5" /></button>
    </header>
    {error && <div role="alert" className="flex items-center gap-2 px-3 pb-2 text-xs text-destructive"><span className="flex-1">{error}</span><button type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button></div>}
    <div ref={container} className="min-h-0 flex-1 overflow-hidden px-2 pb-2" />
  </section>
}
