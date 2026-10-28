import { describe, expect, test } from 'bun:test'
import { createThinClientUpdateApi, registerThinClientUpdateHandlers } from '../thin-client-updates'
import type { UpdateInfo } from '../../shared/types'

function fixture() {
  const handlers = new Map<string, (...args: any[]) => any>()
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  let dismissed: string | null = null
  let checks = 0, installs = 0, remoteCalls = 0
  let sink: (channel: string, target: any, ...args: any[]) => void = () => {}
  const info: UpdateInfo = { available: false, currentVersion: '0.15.6', latestVersion: '0.15.6', downloadState: 'idle', downloadProgress: 0 }
  const ipc = {
    handle: (ch: string, handler: (...args: any[]) => any) => { handlers.set(ch, handler) },
    invoke: async (ch: string, ...args: any[]) => {
      const handler = handlers.get(ch)
      if (!handler) throw new Error('No local handler for: ' + ch)
      return handler({}, ...args)
    },
    on: (ch: string, callback: (...args: any[]) => void) => {
      if (!listeners.has(ch)) listeners.set(ch, new Set())
      listeners.get(ch)!.add(callback)
    },
    removeListener: (ch: string, callback: (...args: any[]) => void) => { listeners.get(ch)?.delete(callback) },
  }
  registerThinClientUpdateHandlers(ipc, {
    checkForUpdates: async (options) => { expect(options.autoDownload).toBe(true); checks++; return info },
    getUpdateInfo: () => info,
    installUpdate: async () => { installs++ },
    setAutoUpdateEventSink: (fn) => { sink = fn },
  }, { getDismissedUpdateVersion: () => dismissed, setDismissedUpdateVersion: version => { dismissed = version } },
  (channel, ...args) => { for (const callback of listeners.get(channel) ?? []) callback({}, ...args) })
  const api = Object.assign({ checkForUpdates: async (): Promise<UpdateInfo> => { remoteCalls++; throw new Error('No handler for: update:check') } }, createThinClientUpdateApi(ipc))
  return { api, emit: (ch: string, ...args: any[]) => sink(ch, { to: 'all' }, ...args), counts: () => ({ checks, installs, remoteCalls }) }
}

describe('thin-client Update button to local main process', () => {
  test('check and getInfo complete locally without the Linux update:check handler', async () => {
    const f = fixture()
    expect((await f.api.getUpdateInfo()).currentVersion).toBe('0.15.6')
    expect((await f.api.checkForUpdates()).latestVersion).toBe('0.15.6')
    expect(f.counts()).toEqual({ checks: 1, installs: 0, remoteCalls: 0 })
  })
  test('check never implicitly invokes installation', async () => {
    const f = fixture(); await f.api.checkForUpdates()
    expect(f.counts().installs).toBe(0)
    await f.api.installUpdate()
    expect(f.counts().installs).toBe(1)
  })
  test('dismissal is stored and read locally', async () => {
    const f = fixture()
    expect(await f.api.getDismissedUpdateVersion()).toBeNull()
    await f.api.dismissUpdate('0.15.7')
    expect(await f.api.getDismissedUpdateVersion()).toBe('0.15.7')
  })
  test('main-process state and progress reach renderer; unsubscribe removes listeners', () => {
    const f = fixture(); const state: any[] = [], progress: number[] = []
    const stopState = f.api.onUpdateAvailable(value => state.push(value))
    const stopProgress = f.api.onUpdateDownloadProgress(value => progress.push(value))
    f.emit('update:available', { downloadState: 'ready' }); f.emit('update:downloadProgress', 42)
    expect(state).toEqual([{ downloadState: 'ready' }]); expect(progress).toEqual([42])
    stopState(); stopProgress()
    f.emit('update:available', {}); f.emit('update:downloadProgress', 99)
    expect(state).toHaveLength(1); expect(progress).toEqual([42])
  })
})
