import { randomUUID } from 'node:crypto'
import type { SessionTerminalEvent, SessionTerminalSnapshot, TerminalSize } from '@craft-agent/shared/protocol'

export interface PtyProcess {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: 'SIGHUP' | 'SIGKILL'): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void }
}
export interface TerminalSessionContext { workspaceId: string; directory: string }
export interface SessionTerminalDependencies {
  resolveSession(sessionId: string): Promise<TerminalSessionContext>
  spawn(directory: string, size: TerminalSize): Promise<PtyProcess>
  push(clientId: string, event: SessionTerminalEvent): void
}
interface TerminalRecord {
  snapshot: SessionTerminalSnapshot
  directory: string
  workspaceId: string
  process: PtyProcess
  clients: Set<string>
  disposables: Array<{ dispose(): void }>
  pending: string
  flushTimer?: ReturnType<typeof setTimeout>
  exit: Promise<void>
  resolveExit(): void
  stopping?: Promise<void>
  stopRequested?: boolean
}

export const TERMINAL_SCROLLBACK_BYTES = 256 * 1024
const MAX_WRITE_BYTES = 64 * 1024
const FLUSH_INTERVAL_MS = 32

export function validateTerminalSize(size: TerminalSize): TerminalSize {
  if (!size || !Number.isInteger(size.cols) || !Number.isInteger(size.rows)
    || size.cols < 2 || size.cols > 500 || size.rows < 1 || size.rows > 300) throw new Error('Invalid terminal dimensions.')
  return { cols: size.cols, rows: size.rows }
}
function tail(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text)
  if (bytes.length <= TERMINAL_SCROLLBACK_BYTES) return { text, truncated: false }
  let start = bytes.length - TERMINAL_SCROLLBACK_BYTES
  // A reconnect must not start with a partial UTF-8 code point.
  while ((bytes[start]! & 0xc0) === 0x80) start++
  return { text: bytes.subarray(start).toString('utf8'), truncated: true }
}

/** One server-owned PTY per session; disconnecting a viewer never kills its shell. */
export class SessionTerminalService {
  private records = new Map<string, TerminalRecord>()
  private openings = new Map<string, Promise<SessionTerminalSnapshot>>()
  private generations = new Map<string, number>()
  private disposed = false
  constructor(private deps: SessionTerminalDependencies) {}

  async open(sessionId: string, clientId: string, size: TerminalSize): Promise<SessionTerminalSnapshot> {
    validateTerminalSize(size)
    const context = await this.deps.resolveSession(sessionId)
    if (this.disposed) throw new Error('The terminal service is shutting down.')
    const previous = this.openings.get(sessionId)
    if (previous) {
      await previous
      return this.open(sessionId, clientId, size)
    }
    const record = this.records.get(sessionId)
    if (record?.stopRequested) throw new Error('The terminal is stopping. Wait before reopening it.')
    if (record && record.directory === context.directory && record.workspaceId === context.workspaceId) {
      record.clients.add(clientId)
      this.flush(record)
      return { ...record.snapshot }
    }
    if (record) await this.stopSession(sessionId)
    const generation = this.generations.get(sessionId) ?? 0
    const opening = this.create(sessionId, clientId, context, size, generation)
    this.openings.set(sessionId, opening)
    try { return await opening } finally { if (this.openings.get(sessionId) === opening) this.openings.delete(sessionId) }
  }

  private async create(sessionId: string, clientId: string, context: TerminalSessionContext, size: TerminalSize, generation: number): Promise<SessionTerminalSnapshot> {
    const process = await this.deps.spawn(context.directory, size)
    // Archive/close may race the native spawn. Revalidate before publishing the process.
    try {
      const current = await this.deps.resolveSession(sessionId)
      if (this.disposed || (this.generations.get(sessionId) ?? 0) !== generation
        || current.directory !== context.directory || current.workspaceId !== context.workspaceId) throw new Error('The session changed while its terminal was opening.')
    } catch (error) { await terminatePty(process); throw error }
    let resolveExit!: () => void
    const exit = new Promise<void>(resolve => { resolveExit = resolve })
    const record: TerminalRecord = {
      snapshot: { id: randomUUID(), sessionId, sequence: 0, status: 'running', output: '', truncated: false },
      directory: context.directory, workspaceId: context.workspaceId, process, clients: new Set([clientId]), disposables: [], pending: '', exit, resolveExit,
    }
    this.records.set(sessionId, record)
    record.disposables.push(process.onData(data => this.receive(record, data)))
    record.disposables.push(process.onExit(({ exitCode }) => {
      record.resolveExit()
      this.flush(record)
      record.snapshot = { ...record.snapshot, status: 'exited', exitCode, sequence: record.snapshot.sequence + 1 }
      this.publish(record, { type: 'snapshot', snapshot: { ...record.snapshot } })
    }))
    return { ...record.snapshot }
  }

  private receive(record: TerminalRecord, data: string): void {
    if (this.records.get(record.snapshot.sessionId) !== record || record.snapshot.status !== 'running') return
    const retained = tail(record.snapshot.output + data)
    record.snapshot.output = retained.text
    record.snapshot.truncated ||= retained.truncated
    // Bound pending output even for a noisy process with no viewers.
    record.pending = tail(record.pending + data).text
    if (!record.flushTimer) record.flushTimer = setTimeout(() => this.flush(record), FLUSH_INTERVAL_MS)
  }
  private flush(record: TerminalRecord): void {
    if (record.flushTimer) clearTimeout(record.flushTimer)
    record.flushTimer = undefined
    if (!record.pending) return
    const data = record.pending
    record.pending = ''
    record.snapshot.sequence++
    // Repainting from the bounded snapshot avoids silently losing output when pending data overflows.
    if (Buffer.byteLength(data) >= TERMINAL_SCROLLBACK_BYTES - 4) this.publish(record, { type: 'snapshot', snapshot: { ...record.snapshot } })
    else this.publish(record, { type: 'output', id: record.snapshot.id, sessionId: record.snapshot.sessionId, sequence: record.snapshot.sequence, data })
  }
  private publish(record: TerminalRecord, event: SessionTerminalEvent): void {
    for (const client of record.clients) this.deps.push(client, event)
  }
  private async current(sessionId: string, terminalId: string, clientId: string): Promise<TerminalRecord> {
    const context = await this.deps.resolveSession(sessionId)
    const record = this.records.get(sessionId)
    if (!record || record.snapshot.id !== terminalId || !record.clients.has(clientId)) throw new Error('Open this session terminal before using it.')
    if (record.directory !== context.directory || record.workspaceId !== context.workspaceId) {
      await this.stopSession(sessionId)
      throw new Error('The session checkout changed. Reopen the terminal.')
    }
    return record
  }
  async write(sessionId: string, terminalId: string, clientId: string, data: string): Promise<void> {
    if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_WRITE_BYTES) throw new Error('Terminal input exceeds 64 KiB.')
    const record = await this.current(sessionId, terminalId, clientId)
    if (record.stopRequested || record.snapshot.status !== 'running') throw new Error('This terminal has exited. Close it before opening another.')
    record.process.write(data)
  }
  async resize(sessionId: string, terminalId: string, clientId: string, size: TerminalSize): Promise<void> {
    validateTerminalSize(size)
    const record = await this.current(sessionId, terminalId, clientId)
    if (record.snapshot.status === 'running') record.process.resize(size.cols, size.rows)
  }
  async close(sessionId: string, terminalId: string, clientId: string): Promise<void> {
    await this.current(sessionId, terminalId, clientId)
    await this.stopSession(sessionId)
  }
  detach(sessionId: string, clientId: string): void { this.records.get(sessionId)?.clients.delete(clientId) }
  dropClient(clientId: string): void { for (const record of this.records.values()) record.clients.delete(clientId) }
  hasRunningSession(sessionId: string): boolean {
    return this.openings.has(sessionId) || this.records.get(sessionId)?.snapshot.status === 'running'
  }
  async stopSession(sessionId: string): Promise<void> {
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1)
    const stoppingRecord = this.records.get(sessionId)
    if (stoppingRecord) stoppingRecord.stopRequested = true
    await this.openings.get(sessionId)?.catch(() => {})
    const record = this.records.get(sessionId)
    if (!record) return
    if (record.stopping) return record.stopping
    record.stopping = (async () => {
      this.flush(record)
      if (record.snapshot.status === 'running') await terminatePty(record.process, record.exit)
      this.records.delete(sessionId)
      for (const subscription of record.disposables) subscription.dispose()
    })()
    try { await record.stopping } catch (error) { record.stopping = undefined; throw error }
  }
  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all([...new Set([...this.records.keys(), ...this.openings.keys()])].map(id => this.stopSession(id)))
  }
}

/** Checkout cleanup must wait for native exit, not just the act of requesting a signal. */
async function terminatePty(process: PtyProcess, existingExit?: Promise<void>): Promise<void> {
  let subscription: { dispose(): void } | undefined
  const exit = existingExit ?? new Promise<void>(resolve => { subscription = process.onExit(() => resolve()) })
  let timeout: ReturnType<typeof setTimeout> | undefined
  let force: ReturnType<typeof setTimeout> | undefined
  try {
    process.kill('SIGHUP')
    force = setTimeout(() => process.kill('SIGKILL'), 1_000)
    await Promise.race([exit, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('The terminal did not exit. Its checkout has been preserved.')), 4_000) })])
  } finally {
    if (timeout) clearTimeout(timeout)
    if (force) clearTimeout(force)
    subscription?.dispose()
  }
}
