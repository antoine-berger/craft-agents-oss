import { describe, expect, test } from 'bun:test'
import { SessionTerminalService, TERMINAL_SCROLLBACK_BYTES, type PtyProcess } from './session-terminal'
import type { SessionTerminalEvent } from '@craft-agent/shared/protocol'

class FakePty implements PtyProcess {
  inputs: string[] = []
  sizes: number[][] = []
  signals: string[] = []
  data = new Set<(data: string) => void>()
  exits = new Set<(event: { exitCode: number }) => void>()
  autoExit = true
  write(data: string) { this.inputs.push(data) }
  resize(cols: number, rows: number) { this.sizes.push([cols, rows]) }
  kill(signal = 'SIGHUP') { this.signals.push(signal); if (this.autoExit) this.exit(0) }
  onData(listener: (data: string) => void) { this.data.add(listener); return { dispose: () => { this.data.delete(listener) } } }
  onExit(listener: (event: { exitCode: number }) => void) { this.exits.add(listener); return { dispose: () => { this.exits.delete(listener) } } }
  output(data: string) { for (const listener of this.data) listener(data) }
  exit(exitCode: number) { for (const listener of this.exits) listener({ exitCode }) }
}
function fixture() {
  let archived = false
  let directory = '/fixture/worktree'
  let spawns = 0
  const process = new FakePty()
  const pushes: Array<{ client: string; event: SessionTerminalEvent }> = []
  const service = new SessionTerminalService({
    async resolveSession() { if (archived) throw new Error('Archived'); return { workspaceId: 'workspace', directory } },
    async spawn() { spawns++; return process },
    push(client, event) { pushes.push({ client, event }) },
  })
  return { service, process, pushes, archive: () => { archived = true }, move: () => { directory = '/fixture/another-worktree' }, spawns: () => spawns }
}
const size = { cols: 80, rows: 24 }

describe('session terminal lifecycle', () => {
  test('concurrent opens share one PTY and reconnect replays bounded output only to subscribers', async () => {
    const f = fixture()
    const [a, b] = await Promise.all([f.service.open('chat', 'a', size), f.service.open('chat', 'b', size)])
    expect(a.id).toBe(b.id); expect(f.spawns()).toBe(1)
    f.process.output('hello')
    f.service.dropClient('a')
    const resumed = await f.service.open('chat', 'a-new', size)
    expect(resumed.output).toBe('hello'); expect(resumed.sequence).toBe(1); expect(f.spawns()).toBe(1)
    expect(new Set(f.pushes.map(push => push.client))).toEqual(new Set(['b', 'a-new']))
    await expect(f.service.write('chat', a.id, 'outsider', 'ls\r')).rejects.toThrow('Open this session')
    await f.service.dispose()
  })
  test('input and resize require a current subscribed terminal and valid bounded arguments', async () => {
    const f = fixture(); const opened = await f.service.open('chat', 'a', size)
    await f.service.write('chat', opened.id, 'a', 'pwd\r')
    await f.service.resize('chat', opened.id, 'a', { cols: 120, rows: 40 })
    expect(f.process.inputs).toEqual(['pwd\r']); expect(f.process.sizes).toEqual([[120, 40]])
    await expect(f.service.write('chat', 'stale-id', 'a', 'rm')).rejects.toThrow('Open this session')
    await expect(f.service.write('chat', opened.id, 'a', 'x'.repeat(65537))).rejects.toThrow('64 KiB')
    await expect(f.service.resize('chat', opened.id, 'a', { cols: Infinity, rows: -1 })).rejects.toThrow('dimensions')
    f.archive()
    await expect(f.service.write('chat', opened.id, 'a', 'anything')).rejects.toThrow('Archived')
    await f.service.stopSession('chat')
  })
  test('archive/close waits for native exit and prevents writes while stopping', async () => {
    const f = fixture(); f.process.autoExit = false
    const opened = await f.service.open('chat', 'a', size)
    let stopped = false
    const stop = f.service.stopSession('chat').then(() => { stopped = true })
    await Promise.resolve(); await Promise.resolve()
    expect(stopped).toBe(false); expect(f.service.hasRunningSession('chat')).toBe(true)
    await expect(f.service.write('chat', opened.id, 'a', 'late')).rejects.toThrow('exited')
    f.process.exit(0)
    await stop
    expect(stopped).toBe(true); expect(f.service.hasRunningSession('chat')).toBe(false)
    expect(f.process.signals).toEqual(['SIGHUP'])
  })
  test('a changed checkout stops the old PTY before allowing further input', async () => {
    const f = fixture(); const opened = await f.service.open('chat', 'a', size)
    f.move()
    await expect(f.service.write('chat', opened.id, 'a', 'late')).rejects.toThrow('checkout changed')
    expect(f.process.inputs).toEqual([]); expect(f.process.signals).toEqual(['SIGHUP'])
  })
  test('archive during asynchronous spawn kills the unpublished PTY', async () => {
    const process = new FakePty()
    let archived = false
    let finishSpawn!: (process: PtyProcess) => void
    const service = new SessionTerminalService({
      async resolveSession() { if (archived) throw new Error('Archived'); return { workspaceId: 'w', directory: '/worktree' } },
      spawn: () => new Promise(resolve => { finishSpawn = resolve }), push() {},
    })
    const open = service.open('chat', 'client', size)
    await Promise.resolve(); await Promise.resolve()
    archived = true
    const stopped = service.stopSession('chat')
    finishSpawn(process)
    await expect(open).rejects.toThrow('Archived')
    await stopped
    expect(process.signals).toEqual(['SIGHUP'])
    expect(service.hasRunningSession('chat')).toBe(false)
  })
  test('scrollback stays UTF-8 safe and within the replay budget', async () => {
    const f = fixture(); await f.service.open('chat', 'a', size)
    f.process.output('é'.repeat(TERMINAL_SCROLLBACK_BYTES))
    const replay = await f.service.open('chat', 'a', size)
    expect(Buffer.byteLength(replay.output)).toBeLessThanOrEqual(TERMINAL_SCROLLBACK_BYTES)
    expect(replay.output).not.toContain('�'); expect(replay.truncated).toBe(true)
    await f.service.dispose()
  })
})
