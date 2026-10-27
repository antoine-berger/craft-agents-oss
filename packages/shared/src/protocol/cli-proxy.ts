export type CliProxyProvider = 'claude' | 'codex'

export interface CliProxyAccount {
  id: string
  name: string
  provider: CliProxyProvider
  email?: string
  disabled: boolean
  status: string
}

export interface CliProxyStatus {
  enabled: boolean
  running: boolean
  version: string
  phase: 'stopped' | 'starting' | 'running' | 'error'
  accounts: CliProxyAccount[]
  models: string[]
  error?: string
}

export interface CliProxyOAuthFlow {
  provider: CliProxyProvider
  url: string
  state: string
}

export type CliProxyCommand =
  | { action: 'enable' | 'disable' | 'importCraft' | 'syncModels' }
  | { action: 'setAccountEnabled'; id: string; enabled: boolean }
  | { action: 'startOAuth'; provider: CliProxyProvider }
  | { action: 'completeOAuth'; state: string; code: string; error?: string }
  | { action: 'oauthStatus' | 'cancelOAuth'; state: string }

export interface CliProxyResult {
  status: CliProxyStatus
  oauth?: CliProxyOAuthFlow
  oauthStatus?: 'wait' | 'ok' | 'error'
  imported?: number
}

/** Authentication material stays in the preload/server; never returned to the renderer. */
export interface CliProxyImportAccount {
  provider: CliProxyProvider
  label: string
  accessToken: string
  refreshToken?: string
  idToken?: string
  email?: string
  accountId?: string
  expiresAt?: number
}
