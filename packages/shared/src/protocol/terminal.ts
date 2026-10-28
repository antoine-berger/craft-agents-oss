/** User-operated PTYs live on the workspace server and are bound to one chat's checkout. */
export const TERMINAL_CHANNELS = {
  OPEN: 'terminal:open',
  WRITE: 'terminal:write',
  RESIZE: 'terminal:resize',
  CLOSE: 'terminal:close',
  DETACH: 'terminal:detach',
  CHANGED: 'terminal:changed',
} as const

export interface TerminalSize { cols: number; rows: number }
export interface SessionTerminalSnapshot {
  id: string
  sessionId: string
  sequence: number
  status: 'running' | 'exited'
  output: string
  truncated: boolean
  exitCode?: number
}
export type SessionTerminalEvent =
  | { type: 'output'; id: string; sessionId: string; sequence: number; data: string }
  | { type: 'snapshot'; snapshot: SessionTerminalSnapshot }

export interface SessionTerminalAPI {
  openSessionTerminal(sessionId: string, size: TerminalSize): Promise<SessionTerminalSnapshot>
  writeSessionTerminal(sessionId: string, terminalId: string, data: string): Promise<void>
  resizeSessionTerminal(sessionId: string, terminalId: string, size: TerminalSize): Promise<void>
  closeSessionTerminal(sessionId: string, terminalId: string): Promise<void>
  detachSessionTerminal(sessionId: string): Promise<void>
  onSessionTerminalChanged(callback: (event: SessionTerminalEvent) => void): () => void
  onReconnected(callback: () => void): () => void
}
