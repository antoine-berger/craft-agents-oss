/** Keep Craft's existing update buttons and RPCs; all updates belong to this fork. */
export {
  checkForUpdates, checkForUpdatesOnLaunch, getUpdateInfo, installUpdate, isUpdating,
  setAutoUpdateEventSink, setBeforeUpdateInstallHook, setBeforeUpdateQuitHook, setInstallQuitFailedHook,
} from './fork-update'
export type { UpdateOnLaunchResult } from './fork-update'
