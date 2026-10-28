/** Manual updates for Antoine's fork. No upstream feed and no unattended restarts. */
import { app, dialog } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { serverUpdateError } from '../shared/update-errors'
import type { UpdateInfo } from '../shared/types'
import type { EventSink } from '@craft-agent/server-core/transport'
import { FORK_RELEASE_URL, isNewerVersion, parseForkRelease, type ForkAsset, type ForkRelease } from './fork-release'

const exec = promisify(execFile)
const configDir = () => process.env.CRAFT_CONFIG_DIR || join(homedir(), '.craft-agent')
const cacheDir = () => join(app.getPath('home'), 'Library', 'Caches', 'antoine-craft-updates')
let info: UpdateInfo = { available: false, currentVersion: app.getVersion(), latestVersion: null, downloadState: 'idle', downloadProgress: 0 }
let release: ForkRelease | null = null
let preparedApp: string | null = null
let server: { currentVersion: string; available: boolean; staged?: boolean } | null = null
let serverError: string | null = null
let sink: EventSink | null = null
let checking: Promise<UpdateInfo> | null = null
let installing = false
let updating = false
let beforeQuit: (() => void) | null = null
let beforeInstall: (() => Promise<void>) | null = null
let installFailed: (() => void) | null = null

export function setBeforeUpdateQuitHook(fn: () => void): void { beforeQuit = fn }
export function setBeforeUpdateInstallHook(fn: () => Promise<void>): void { beforeInstall = fn }
export function setInstallQuitFailedHook(fn: () => void): void { installFailed = fn }
export function setAutoUpdateEventSink(fn: EventSink): void { sink = fn }
export function isUpdating(): boolean { return updating }
export function getUpdateInfo(): UpdateInfo { return { ...info } }
function publish(change: Partial<UpdateInfo>): void {
  info = { ...info, ...change }
  sink?.('update:available', { to: 'all' }, getUpdateInfo())
}

interface ServerConfig { host: string; jump: string }
async function serverConfig(): Promise<ServerConfig | null> {
  const file = join(configDir(), 'fork-update.json')
  const meta = await stat(file).catch(() => null)
  if (!meta) return null
  if (!meta.isFile() || (meta.mode & 0o077)) throw new Error('fork-update.json must be private (chmod 600)')
  const config = JSON.parse(await readFile(file, 'utf8'))
  if (!/^[\w][\w.@-]*$/.test(config.host) || !/^[\w][\w.@-]*$/.test(config.jump)) throw new Error('Invalid update SSH destination')
  return config
}
async function serverCommand(action: 'check' | 'stage' | 'apply', target: ForkRelease, force = false): Promise<any> {
  const config = await serverConfig()
  if (!config) return null
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-J', config.jump, config.host,
    '/usr/local/sbin/craft-fork-update', action, target.version, target.assets['server-linux-x64'].sha256]
  if (action === 'apply') args.push('--authorize-restart')
  if (action === 'apply' && force) args.push('--force')
  try {
    const result = await exec('/usr/bin/ssh', args, { timeout: action === 'check' ? 30_000 : 30 * 60_000, maxBuffer: 1024 * 1024 })
    return JSON.parse(result.stdout)
  } catch (error) { throw serverUpdateError(error) }
}

async function verifyFile(file: string, asset: ForkAsset): Promise<void> {
  if ((await stat(file)).size !== asset.size) throw new Error('Update size mismatch')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  if (hash.digest('hex') !== asset.sha256) throw new Error('Update checksum mismatch')
}
async function download(asset: ForkAsset, file: string): Promise<void> {
  try { await verifyFile(file, asset); return } catch { /* Missing or invalid cached download. */ }
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(15 * 60_000) })
  if (!response.ok || !response.body) throw new Error(`Fork download failed: HTTP ${response.status}`)
  const partial = file + '.partial'
  const handle = await open(partial, 'w', 0o600)
  let received = 0
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.length
      if (received > asset.size) throw new Error('Update exceeds expected size')
      await handle.writeFile(chunk)
      const percent = Math.round(100 * received / asset.size)
      sink?.('update:downloadProgress', { to: 'all' }, percent)
    }
  } finally { await handle.close() }
  await verifyFile(partial, asset)
  await rename(partial, file)
}
async function prepareMac(target: ForkRelease): Promise<string> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This fork currently publishes macOS Apple Silicon updates only')
  const root = join(cacheDir(), target.version)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const zip = join(root, 'Craft-Agents-arm64.zip')
  await download(target.assets['darwin-arm64'], zip)
  const listing = (await exec('/usr/bin/zipinfo', ['-1', zip], { maxBuffer: 8 * 1024 * 1024 })).stdout.trim().split('\n')
  if (listing.some(name => !name.startsWith('Craft Agents.app/') || name.split('/').includes('..'))) throw new Error('Unexpected paths in app update')
  const unpack = join(root, 'unpacked')
  await rm(unpack, { recursive: true, force: true })
  await mkdir(unpack, { mode: 0o700 })
  await exec('/usr/bin/ditto', ['-x', '-k', zip, unpack], { timeout: 300_000 })
  const candidate = join(unpack, 'Craft Agents.app')
  const plist = join(candidate, 'Contents/Info.plist')
  const bundle = (await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist])).stdout.trim()
  const version = (await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist])).stdout.trim()
  if (bundle !== 'com.lukilabs.craft-agent' || version !== target.version) throw new Error('Unexpected app identity or version')
  await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', candidate])
  return candidate
}

async function check(options: { autoDownload?: boolean }): Promise<UpdateInfo> {
  if (installing) throw new Error('Update installation is already in progress')
  publish({ error: undefined, downloadState: 'idle', available: false })
  server = null; serverError = null; preparedApp = null; release = null
  const response = await fetch(FORK_RELEASE_URL, { signal: AbortSignal.timeout(30_000) })
  if (response.status === 404) throw new Error('No fork release published yet. Publish a version from the Fork release workflow in your GitHub repository.')
  if (!response.ok) throw new Error(`Fork release check failed: HTTP ${response.status}`)
  release = parseForkRelease(await response.json())
  try { server = await serverCommand('check', release) } catch (error) { serverError = String(error) }
  const macAvailable = isNewerVersion(release.version, app.getVersion())
  const available = macAvailable || server?.available === true
  if (!available && serverError) throw new Error(`Server update check failed: ${serverError}`)
  publish({ available, latestVersion: release.version })
  if (!available || options.autoDownload === false) return getUpdateInfo()
  publish({ downloadState: 'downloading', downloadProgress: 0 })
  if (macAvailable) preparedApp = await prepareMac(release)
  // Preparing uses disk only. It never changes the running service or its configuration.
  if (server?.available) {
    try { server = await serverCommand('stage', release) } catch (error) { serverError = String(error) }
  }
  if (!preparedApp && !server?.staged) throw new Error(serverError || 'No update was prepared')
  publish({ downloadState: 'ready', downloadProgress: 100 })
  return getUpdateInfo()
}
export async function checkForUpdates(options: { autoDownload?: boolean } = {}): Promise<UpdateInfo> {
  if (checking) return checking
  checking = check(options).catch(error => {
    publish({ downloadState: 'error', error: error instanceof Error ? error.message : String(error) })
    throw error
  }).finally(() => { checking = null })
  return checking
}

// Run after the client exits. Keep both the old bundle and local configuration for rollback.
export const MAC_INSTALL_SCRIPT = `#!/bin/bash
set -euo pipefail
pid="$1"; incoming="$2"; target="$3"; backup="$4"
for ((i=0; i<600; i++)); do
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 0.2
done
if kill -0 "$pid" 2>/dev/null; then echo 'Client did not exit; nothing replaced'; exit 1; fi
if [[ -e "$backup" || ! -d "$incoming" || ! -d "$target" ]]; then exit 1; fi
mv "$target" "$backup"
if ! mv "$incoming" "$target"; then mv "$backup" "$target"; /usr/bin/open "$target"; exit 1; fi
if ! /usr/bin/codesign --verify --deep --strict "$target" || ! /usr/bin/open -n "$target"; then
  mv "$target" "$incoming.failed"
  mv "$backup" "$target"
  /usr/bin/open "$target"
  exit 1
fi
`;
async function installMac(): Promise<void> {
  if (!preparedApp || !release) throw new Error('No app update prepared')
  // Recheck the archive and signature at installation, not only when downloading.
  await verifyFile(join(cacheDir(), release.version, 'Craft-Agents-arm64.zip'), release.assets['darwin-arm64'])
  await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', preparedApp])
  const target = resolve(app.getAppPath(), '../../..')
  if (!target.endsWith('/Craft Agents.app')) throw new Error('Install Craft Agents in Applications before updating')
  const stamp = Date.now().toString()
  const incoming = join(dirname(target), `.Craft Agents.incoming-${stamp}.app`)
  const backup = join(dirname(target), `.Craft Agents.before-fork-${stamp}.app`)
  await exec('/usr/bin/ditto', [preparedApp, incoming], { timeout: 300_000 })
  const root = join(cacheDir(), release.version)
  const dataBackup = join(root, `config-before-${stamp}`)
  await exec('/usr/bin/ditto', [configDir(), dataBackup], { timeout: 300_000 })
  await chmod(dataBackup, 0o700)
  const helper = join(root, 'install.sh')
  await writeFile(helper, MAC_INSTALL_SCRIPT, { mode: 0o700 })
  const log = await open(join(root, 'install.log'), 'a', 0o600)
  updating = true
  try {
    beforeQuit?.()
    await beforeInstall?.()
    const child = spawn('/bin/bash', [helper, String(process.pid), incoming, target, backup], {
      detached: true, stdio: ['ignore', log.fd, log.fd],
    })
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    child.unref()
    app.exit(0)
  } catch (error) { updating = false; installFailed?.(); throw error } finally { await log.close() }
}
export async function installUpdate(): Promise<void> {
  if (installing) throw new Error('Update installation is already in progress')
  if (checking || !release || info.downloadState !== 'ready') throw new Error('Check and prepare the fork update first')
  installing = true
  publish({ error: undefined })
  try {
    const choices: Array<'cancel' | 'app' | 'server'> = ['cancel']
    const buttons = ['Annuler']
    if (preparedApp) { choices.push('app'); buttons.push('Mettre à jour l’app Mac') }
    if (server?.available && server.staged) { choices.push('server'); buttons.push('Mettre à jour le serveur…') }
    const answer = await dialog.showMessageBox({ type: 'question', title: 'Mise à jour de ton fork',
      message: `Craft Agents · ${release.version}`, detail: `Dépôt : antoine-berger/craft-agents-oss\nApp Mac : ${app.getVersion()}\nServeur : ${server?.currentVersion ?? 'non connecté'}${serverError ? '\nServeur non prêt : ' + serverError : ''}\n\nL’app et le serveur se mettent à jour séparément.`,
      buttons, defaultId: 0, cancelId: 0, noLink: true })
    if (choices[answer.response] === 'app') await installMac()
    if (choices[answer.response] === 'server') {
      const consent = await dialog.showMessageBox({ type: 'warning', title: 'Autoriser le redémarrage du serveur',
        message: `Installer ${release.version} et redémarrer le serveur ?`,
        detail: 'Installer refuse si des agents ou des commandes tournent. Forcer les interrompt et redémarre immédiatement le serveur. Les conversations sont sauvegardées et la version précédente conservée.',
        buttons: ['Annuler', 'Installer', 'Forcer et redémarrer'], defaultId: 0, cancelId: 0, noLink: true })
      if (consent.response === 1 || consent.response === 2) {
        try { server = await serverCommand('apply', release, consent.response === 2) }
        catch (error) {
          if (error instanceof Error && error.name === 'ServerUpdateBusy') {
            publish({ error: 'Serveur occupé · Réessaie après la fin des sessions en cours.' })
            return
          }
          throw error
        }
        await dialog.showMessageBox({ type: 'info', message: `Serveur mis à jour : ${server?.currentVersion}`, buttons: ['OK'] })
        publish({ available: !!preparedApp, downloadState: preparedApp ? 'ready' : 'idle' })
      }
    }
  } finally { installing = false }
}

export interface UpdateOnLaunchResult { action: 'none' | 'skipped' | 'ready' | 'downloading'; reason?: string; version?: string | null }
export async function checkForUpdatesOnLaunch(): Promise<UpdateOnLaunchResult> {
  // No SSH, downloads, server changes, or application replacements on launch/quit.
  return { action: 'skipped', reason: 'manual-fork-updates' }
}
