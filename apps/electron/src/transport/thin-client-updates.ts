/** Updates belong to the Mac main process, even when all chats live remotely. */
import type { UpdateInfo } from '../shared/types'

interface MainIpc {
  handle(channel: string, handler: (event: any, ...args: any[]) => any): void
}
interface RendererIpc {
  invoke(channel: string, ...args: any[]): Promise<any>
  on(channel: string, listener: (event: any, ...args: any[]) => void): unknown
  removeListener(channel: string, listener: (event: any, ...args: any[]) => void): unknown
}
interface UpdateRuntime {
  checkForUpdates(options: { autoDownload: boolean }): Promise<UpdateInfo>
  getUpdateInfo(): UpdateInfo
  installUpdate(): Promise<void>
  setAutoUpdateEventSink(sink: (channel: string, target: any, ...args: any[]) => void): void
}
interface UpdatePreferences {
  getDismissedUpdateVersion(): string | null
  setDismissedUpdateVersion(version: string): void
}

export function registerThinClientUpdateHandlers(
  ipc: MainIpc,
  updater: UpdateRuntime,
  preferences: UpdatePreferences,
  broadcast: (channel: string, ...args: any[]) => void,
): void {
  ipc.handle('update:check', () => updater.checkForUpdates({ autoDownload: true }))
  ipc.handle('update:getInfo', () => updater.getUpdateInfo())
  ipc.handle('update:install', () => updater.installUpdate())
  ipc.handle('update:dismiss', (_event, version: string) => preferences.setDismissedUpdateVersion(version))
  ipc.handle('update:getDismissed', () => preferences.getDismissedUpdateVersion())
  updater.setAutoUpdateEventSink((channel, _target, ...args) => broadcast(channel, ...args))
}

export function createThinClientUpdateApi(ipc: RendererIpc) {
  const listen = (channel: string, callback: (...args: any[]) => void) => {
    const handler = (_event: any, ...args: any[]) => callback(...args)
    ipc.on(channel, handler)
    return () => { ipc.removeListener(channel, handler) }
  }
  return {
    checkForUpdates: (): Promise<UpdateInfo> => ipc.invoke('update:check'),
    getUpdateInfo: (): Promise<UpdateInfo> => ipc.invoke('update:getInfo'),
    installUpdate: (): Promise<void> => ipc.invoke('update:install'),
    dismissUpdate: (version: string): Promise<void> => ipc.invoke('update:dismiss', version),
    getDismissedUpdateVersion: (): Promise<string | null> => ipc.invoke('update:getDismissed'),
    onUpdateAvailable: (callback: (info: UpdateInfo) => void) => listen('update:available', callback),
    onUpdateDownloadProgress: (callback: (percent: number) => void) => listen('update:downloadProgress', callback),
  }
}
