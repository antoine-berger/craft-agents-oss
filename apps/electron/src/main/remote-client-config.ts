/**
 * Persist the remote thin-client connection independently from a launching shell.
 *
 * Finder and Dock launches do not inherit CRAFT_SERVER_URL/TOKEN exported in a
 * terminal, so read an explicit, permission-restricted file before the Electron
 * main process decides whether to bootstrap a local agent server.
 *
 * This file is CLIENT-only; server-side credentials/sessions live on the server.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface PersistentRemoteClientConfig {
  url: string
  token: string
  workspaceId?: string
}

export function readPersistentRemoteClientConfig(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): PersistentRemoteClientConfig | null {
  const configDir = env.CRAFT_CONFIG_DIR?.trim() || join(home, '.craft-agent')
  const configPath = join(configDir, 'remote-client.json')
  if (!existsSync(configPath)) return null

  const stat = statSync(configPath)
  if (!stat.isFile()) throw new Error(`Remote client config must be a file: ${configPath}`)

  // The connection token grants server access. Refuse accidentally shared files
  // instead of silently exposing the token to other local users.
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`Remote client config must be private (chmod 600 ${configPath})`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    throw new Error(`Invalid JSON in remote client config: ${configPath}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Remote client config must be a JSON object')
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.url !== 'string' || typeof record.token !== 'string' ||
      !record.url.trim() || !record.token.trim()) {
    throw new Error('Remote client config requires non-empty url and token strings')
  }
  let url: URL
  try {
    url = new URL(record.url)
  } catch {
    throw new Error('Remote client config has an invalid server URL')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) {
    throw new Error('Remote client config requires wss:// (ws:// allowed only for localhost)')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Remote client URL must not contain credentials, query parameters or fragments')
  }
  if (record.workspaceId !== undefined &&
      (typeof record.workspaceId !== 'string' || !record.workspaceId.trim())) {
    throw new Error('Remote client workspaceId must be a non-empty string when provided')
  }
  return {
    url: url.toString(),
    token: record.token,
    ...(typeof record.workspaceId === 'string' ? { workspaceId: record.workspaceId } : {}),
  }
}

export function applyPersistentRemoteClientConfig(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): void {
  // An explicit environment connection wins (development/CLI launches).
  if (env.CRAFT_SERVER_URL) return
  const config = readPersistentRemoteClientConfig(env, home)
  if (!config) return
  env.CRAFT_SERVER_URL = config.url
  env.CRAFT_SERVER_TOKEN = config.token
  if (config.workspaceId) env.CRAFT_WORKSPACE_ID = config.workspaceId
}

/** Restore hybrid-mode windows with server workspace ids in thin-client mode. */
export function remoteClientWindowOptions(workspaceId: string, saved?: { url?: string; focused?: boolean }): {
  workspaceId: string; focused?: boolean; restoreUrl?: string
} {
  let restoreUrl: string | undefined
  if (saved?.url) {
    try {
      const url = new URL(saved.url)
      url.searchParams.set('workspaceId', workspaceId)
      url.searchParams.set('ws', workspaceId)
      restoreUrl = url.toString()
    } catch { /* An invalid saved URL falls back to the remote workspace's default route. */ }
  }
  return { workspaceId, focused: saved?.focused, restoreUrl }
}
