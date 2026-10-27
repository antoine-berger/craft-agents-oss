import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync, constants } from 'node:fs'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'
import { addLlmConnection, getLlmConnection, getLlmConnections, updateLlmConnection, loadStoredConfig, saveConfig } from '@craft-agent/shared/config'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import type { CliProxyAccount, CliProxyCommand, CliProxyImportAccount, CliProxyOAuthFlow, CliProxyResult, CliProxyStatus } from '@craft-agent/shared/protocol'
import type { LlmConnection } from '@craft-agent/shared/config'
import { loadWorkspaceConfig, saveWorkspaceConfig } from '@craft-agent/shared/workspaces'
import { CLI_PROXY_VERSION, installCliProxy } from './install'

interface State { enabled: boolean; port: number; connectorAccountId?: string }
interface PendingOAuth { provider: 'claude' | 'codex'; clientId: string; expires: number }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export function publicAccounts(files: Array<Record<string, unknown>>): CliProxyAccount[] {
  return files.filter(file => file.type === 'claude' || file.type === 'codex').map(file => ({
    id: String(file.name), name: String(file.label || file.email || file.name), provider: file.type as 'claude' | 'codex',
    email: typeof file.email === 'string' ? file.email : undefined,
    disabled: file.disabled === true, status: typeof file.status === 'string' ? file.status : 'unknown',
  }))
}

export class CliProxyManager {
  private state: State = { enabled: false, port: 0 }
  private initialized?: Promise<void>
  private launching?: Promise<void>
  private child?: ChildProcess
  private phase: CliProxyStatus['phase'] = 'stopped'
  private error?: string
  private managementKey = ''
  private clientKey = ''
  private quitting = false
  private restarts = 0
  private routedMcpRequests = 0
  private pending = new Map<string, PendingOAuth>()
  readonly root: string

  constructor(root = join(CONFIG_DIR, 'cli-proxy')) {
    this.root = root
    process.once('exit', () => { this.quitting = true; this.child?.kill('SIGTERM') })
  }

  private initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      try {
        const stored = JSON.parse(await readFile(join(this.root, 'state.json'), 'utf8')) as State
        if (typeof stored.enabled !== 'boolean' || !Number.isInteger(stored.port) || stored.port < 0 || stored.port > 65535) throw new Error('Invalid account service state')
        this.state = stored
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    })()
  }

  private async saveState(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const path = join(this.root, 'state.json')
    await writeFile(`${path}.tmp`, JSON.stringify(this.state), { mode: 0o600 })
    await rename(`${path}.tmp`, path)
  }

  async resume(): Promise<void> {
    await this.initialize()
    if (this.state.enabled) this.beginLaunch()
  }

  private beginLaunch(): void {
    if (this.launching || this.child || this.quitting) return
    this.phase = 'starting'
    this.error = undefined
    this.launching = this.launch().catch(() => {
      this.phase = 'error'
      this.error = 'Could not start the integrated account service. Check its private service log and retry.'
    }).finally(() => { this.launching = undefined })
  }

  private async getKey(name: string): Promise<string> {
    const manager = getCredentialManager()
    const slug = `cli-proxy-internal-${name}`
    let value = await manager.getLlmApiKey(slug)
    if (!value) { value = randomBytes(32).toString('hex'); await manager.setLlmApiKey(slug, value) }
    return value
  }

  private async launch(): Promise<void> {
    const binary = await installCliProxy(this.root)
    this.managementKey = await this.getKey('management')
    this.clientKey = await this.getKey('client')
    if (!this.state.port) {
      this.state.port = await new Promise<number>((resolve, reject) => {
        const probe = createServer()
        probe.once('error', reject)
        probe.listen(0, '127.0.0.1', () => {
          const address = probe.address()
          const port = typeof address === 'object' && address ? address.port : 0
          probe.close(() => resolve(port))
        })
      })
      await this.saveState()
    }
    const authDirectory = join(this.root, 'accounts')
    await mkdir(authDirectory, { recursive: true, mode: 0o700 })
    const config = join(this.root, 'config.yaml')
    try { await copyFile(config, `${config}.backup-${Date.now()}`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await writeFile(config, JSON.stringify({
      'config-version': 8,
      server: { host: '127.0.0.1', port: this.state.port, discovery: { enabled: false } },
      management: { 'allow-remote': false, 'secret-key': this.managementKey, 'disable-control-panel': true, 'disable-auto-update-panel': true },
      access: { 'api-keys': [this.clientKey] }, oauth: { 'auth-dir': authDirectory },
      routing: { strategy: 'round-robin', 'session-affinity': true, 'session-affinity-subagents': true },
    }, null, 2), { mode: 0o600 })
    if (!this.state.enabled || this.quitting) return
    const log = openSync(join(this.root, 'service.log'), 'a', 0o600)
    try {
      this.child = spawn(binary, ['--config', config, '--local-model'], {
        cwd: this.root, env: { HOME: homedir(), PATH: process.env.PATH, TMPDIR: tmpdir() },
        stdio: ['ignore', log, log], windowsHide: true,
      })
    } finally { closeSync(log) }
    const child = this.child
    child.once('error', () => { this.error = 'The integrated account service could not be launched'; this.phase = 'error' })
    child.once('exit', () => {
      if (this.child !== child) return
      this.child = undefined
      this.phase = this.state.enabled ? 'error' : 'stopped'
      if (this.state.enabled && !this.quitting && this.restarts++ < 3) {
        const retry = setTimeout(() => this.beginLaunch(), 2000)
        retry.unref()
      }
    })
    for (let attempt = 0; attempt < 40; attempt++) {
      if (child.exitCode !== null) throw new Error('Account service exited during startup')
      try { await this.management('/credentials'); this.phase = 'running'; return }
      catch { await pause(150) }
    }
    child.kill('SIGTERM')
    throw new Error('Account service did not become healthy')
  }

  private get baseUrl(): string { return `http://127.0.0.1:${this.state.port}` }

  private async request(path: string, management: boolean, method = 'GET', body?: unknown, timeoutMs = 10_000, signal?: AbortSignal): Promise<any> {
    const response = await fetch(`${this.baseUrl}${management ? '/v8/management' : ''}${path}`, {
      method, headers: { Authorization: `Bearer ${management ? this.managementKey : this.clientKey}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`Account service request failed (${response.status})`)
    return response.json()
  }

  private management(path: string, method = 'GET', body?: unknown): Promise<any> { return this.request(path, true, method, body) }

  async status(): Promise<CliProxyStatus> {
    await this.initialize()
    const status: CliProxyStatus = { ...this.state, running: this.phase === 'running', version: CLI_PROXY_VERSION,
      phase: this.phase, accounts: [], models: [], error: this.error, routingAll: loadStoredConfig()?.cliProxyRoutingAll === true, connectorAccountId: this.state.connectorAccountId, routedMcpRequests: this.routedMcpRequests }
    if (!status.running) return status
    try {
      const [accounts, models] = await Promise.all([this.management('/credentials'), this.request('/v1/models', false)])
      status.accounts = publicAccounts(accounts.files ?? [])
      status.models = (models.data ?? []).map((model: { id: string }) => model.id)
    } catch { status.error = 'The integrated account service is not responding' }
    return status
  }

  async importAccounts(accounts: CliProxyImportAccount[]): Promise<number> {
    if (this.phase !== 'running') throw new Error('Start the integrated account service first')
    if (!Array.isArray(accounts) || accounts.length > 20) throw new Error('Invalid account import')
    let imported = 0
    for (const account of accounts) {
      if (!['claude', 'codex'].includes(account.provider) || typeof account.accessToken !== 'string' || !account.accessToken
        || account.accessToken.length > 32_768 || /[\r\n]/.test(account.accessToken)) throw new Error('Invalid account credentials')
      for (const token of [account.refreshToken, account.idToken]) {
        if (token !== undefined && (typeof token !== 'string' || token.length > 32_768 || /[\r\n]/.test(token))) throw new Error('Invalid account credentials')
      }
      if (account.expiresAt !== undefined && (typeof account.expiresAt !== 'number' || !Number.isFinite(account.expiresAt))) throw new Error('Invalid account expiry')
      const identity = account.accountId || account.email || account.label
      if (typeof identity !== 'string' || !identity || identity.length > 300) throw new Error('Invalid account identity')
      const name = `${account.provider}-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}.json`
      const path = join(this.root, 'accounts', name)
      try {
        await readFile(path)
        continue // Never overwrite an account or its fresher refresh token during repeat imports.
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await this.management(`/credentials?name=${encodeURIComponent(name)}`, 'POST', {
        type: account.provider, access_token: account.accessToken, refresh_token: account.refreshToken,
        id_token: account.idToken, email: account.email, account_id: account.provider === 'codex' ? account.accountId : undefined,
        account_uuid: account.provider === 'claude' ? account.accountId : undefined, label: account.label,
        expired: account.expiresAt ? new Date(account.expiresAt).toISOString() : undefined,
        last_refresh: new Date().toISOString(),
      })
      imported++
    }
    await this.syncModels()
    return imported
  }

  async importCraftAccounts(): Promise<number> {
    const entries: CliProxyImportAccount[] = []
    for (const connection of getLlmConnections()) {
      if (connection.providerType !== 'anthropic' || connection.authType !== 'oauth') continue
      const stored = await getCredentialManager().getLlmOAuth(connection.slug)
      if (stored?.accessToken) entries.push({ provider: 'claude', label: connection.name,
        accessToken: stored.accessToken, refreshToken: stored.refreshToken, expiresAt: stored.expiresAt,
        email: connection.oauthAccountEmail, accountId: connection.oauthAccountUuid })
    }
    return this.importAccounts(entries)
  }

  private async syncModels(): Promise<void> {
    const status = await this.status()
    for (const provider of ['claude', 'codex'] as const) {
      const models = status.models.filter(model => provider === 'claude' ? model.startsWith('claude-') : /^(gpt-|o[134](?:-|$))/.test(model) && !model.startsWith('gpt-image-'))
      if (!models.length || !status.accounts.some(account => account.provider === provider && !account.disabled)) continue
      const slug = `cli-proxy-${provider}`
      const existing = getLlmConnection(slug)
      const connection: LlmConnection = {
        slug, name: provider === 'claude' ? 'Claude · Account pool' : 'GPT · Account pool',
        createdAt: existing?.createdAt ?? Date.now(),
        providerType: provider === 'claude' ? 'anthropic' : 'pi_compat', authType: 'api_key_with_endpoint',
        piAuthProvider: provider === 'codex' ? 'openai' : undefined,
        baseUrl: `${this.baseUrl}${provider === 'codex' ? '/v1' : ''}`,
        customEndpoint: provider === 'codex' ? { api: 'openai-completions', supportsImages: true, maxTokens: 32768 } : undefined,
        models, defaultModel: existing?.defaultModel && models.includes(existing.defaultModel) ? existing.defaultModel : models[0],
        modelSelectionMode: 'userDefined3Tier',
      }
      if (existing) updateLlmConnection(slug, connection)
      else addLlmConnection(connection)
      await getCredentialManager().setLlmApiKey(slug, this.clientKey)
    }
  }

  async connectorAccount(): Promise<{ id: string; email?: string; name: string }> {
    await this.initialize()
    if (this.phase !== 'running') throw new Error('The integrated account service is unavailable')
    const status = await this.status()
    const nativeEmail = getLlmConnections().find(connection => connection.providerType === 'anthropic' && connection.authType === 'oauth')?.oauthAccountEmail
    const account = this.state.connectorAccountId
      ? status.accounts.find(account => account.id === this.state.connectorAccountId && account.provider === 'claude' && !account.disabled)
      : status.accounts.find(account => account.provider === 'claude' && !account.disabled && account.email === nativeEmail)
        ?? status.accounts.find(account => account.provider === 'claude' && !account.disabled)
    if (!account) throw new Error('Enable the selected Claude account to use its MCP connectors')
    if (!this.state.connectorAccountId) { this.state.connectorAccountId = account.id; await this.saveState() }
    return { id: account.id, email: account.email, name: account.name }
  }

  /** Read-only quota probe. Credentials and auth indexes never leave the server. */
  async relayQuota(accountId: string): Promise<{ status_code: number; header: Record<string, string[]>; body: string }> {
    await this.initialize()
    if (this.phase !== 'running') throw new Error('The integrated account service is unavailable')
    const files = await this.management('/credentials')
    const account = files.files?.find((file: Record<string, unknown>) => file.name === accountId && ['claude', 'codex'].includes(String(file.type)) && !file.disabled)
    if (!account?.auth_index) throw new Error('Quota account is unavailable')
    const header: Record<string, string> = { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' }
    if (account.type === 'claude') header['anthropic-beta'] = 'oauth-2025-04-20'
    else {
      // Management's id_token value is already a sanitized claims object, never a token.
      const claims = account.id_token && typeof account.id_token === 'object' ? account.id_token as Record<string, unknown> : {}
      const identity = account.chatgpt_account_id ?? claims.chatgpt_account_id
      if (typeof identity === 'string' && identity.length < 300 && !/[\r\n]/.test(identity)) header['Chatgpt-Account-Id'] = identity
    }
    const url = account.type === 'claude' ? 'https://api.anthropic.com/api/oauth/usage' : 'https://chatgpt.com/backend-api/wham/usage'
    return this.request('/requests/api-call', true, 'POST', { auth_index: account.auth_index, method: 'GET', url, header }, 30_000)
  }

  /** Only fixed Anthropic connector endpoints can use a stored account credential. */
  async relayConnector(accountId: string, serverId: string | undefined, method: string, headers: Record<string, string> = {}, data?: string, signal?: AbortSignal): Promise<{ status_code: number; header: Record<string, string[]>; body: string }> {
    const selected = await this.connectorAccount()
    if (selected.id !== accountId) throw new Error('Connector account changed; reload the sources')
    if (serverId !== undefined && !/^mcpsrv_[A-Za-z0-9]+$/.test(serverId)) throw new Error('Invalid connector identity')
    if (!['GET', 'POST', 'DELETE'].includes(method) || (!serverId && method !== 'GET')) throw new Error('Unsupported connector method')
    const files = await this.management('/credentials')
    const account = files.files?.find((file: Record<string, unknown>) => file.name === accountId && file.type === 'claude' && !file.disabled)
    if (!account?.auth_index) throw new Error('Connector account is unavailable')
    const header: Record<string, string> = { Authorization: 'Bearer $TOKEN$', 'Accept-Encoding': 'identity', 'anthropic-version': '2023-06-01' }
    const allowed = new Set(['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'x-mcp-client-session-id'])
    for (const [key, value] of Object.entries(headers)) {
      if (value.includes('$TOKEN$')) throw new Error('Invalid connector protocol header')
      if (allowed.has(key.toLowerCase())) header[key] = value
    }
    // The management relay substitutes $TOKEN$ in request bodies too. Preserve literal tool arguments.
    const safeData = data?.replaceAll('$TOKEN$', '\\u0024TOKEN\\u0024')
    if (!serverId) header['anthropic-beta'] = 'mcp-servers-2025-12-04'
    const url = serverId ? `https://mcp-proxy.anthropic.com/v1/mcp/${serverId}`
      : 'https://api.anthropic.com/v1/mcp_servers?limit=1000&include_additional_installs=true'
    this.routedMcpRequests++
    return this.request('/requests/api-call', true, 'POST', { auth_index: account.auth_index, method, url, header, data: safeData }, 65_000, signal)
  }

  connectorFetch(accountId: string, serverId: string): typeof globalThis.fetch {
    const expected = `https://mcp-proxy.anthropic.com/v1/mcp/${serverId}`
    const sessionId = randomUUID()
    return (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      if (request.url !== expected) throw new Error('Unexpected connector destination')
      // CLIProxyAPI buffers HTTP responses. Claude's own client also disables this GET stream.
      if (request.method === 'GET') return new Response(null, { status: 405 })
      const headers: Record<string, string> = {}
      request.headers.forEach((value, key) => { headers[key] = value })
      headers['X-Mcp-Client-Session-Id'] = sessionId
      const result = await this.relayConnector(accountId, serverId, request.method, headers,
        request.body ? await request.text() : undefined, request.signal)
      const responseHeaders = new Headers()
      for (const [key, values] of Object.entries(result.header ?? {})) {
        if (!['content-type', 'mcp-session-id', 'mcp-protocol-version', 'allow', 'retry-after'].includes(key.toLowerCase())) continue
        for (const value of values) responseHeaders.append(key, value)
      }
      return new Response([202, 204, 304].includes(result.status_code) ? null : result.body,
        { status: result.status_code, headers: responseHeaders })
    }) as typeof globalThis.fetch
  }

  private async routeAll(): Promise<void> {
    if (this.phase !== 'running') throw new Error('Start the account manager first')
    await this.syncModels()
    await this.connectorAccount()
    const config = loadStoredConfig()
    if (!config || !getLlmConnection('cli-proxy-claude')) throw new Error('Connect a Claude account first')
    if (!config.cliProxyRoutingAll) await writeFile(join(this.root, `routing-backup-${Date.now()}.json`), JSON.stringify(config), { mode: 0o600 })
    const target = (slug?: string) => {
      const connection = slug ? getLlmConnection(slug) : undefined
      if (!connection || connection.providerType === 'anthropic') return 'cli-proxy-claude'
      if (connection.slug === 'cli-proxy-codex' || ['openai', 'openai-codex'].includes(connection.piAuthProvider ?? '')) return 'cli-proxy-codex'
      throw new Error('This provider is not available through the integrated Claude/GPT account pools')
    }
    const defaultTarget = target(config.defaultLlmConnection)
    if (!getLlmConnection(defaultTarget)) throw new Error('The requested account pool is unavailable')
    const previousModel = config.llmConnections?.find(connection => connection.slug === config.defaultLlmConnection)?.defaultModel
    config.cliProxyRoutingAll = true
    config.defaultLlmConnection = defaultTarget
    // Laya/Jev uses a separate classifier API, so pause it in all-proxy mode; its configuration is retained.
    if (config.decisionLayer?.enabled) config.decisionLayer = { ...config.decisionLayer, enabled: false }
    saveConfig(config)
    if (previousModel && getLlmConnection(defaultTarget)?.models?.some(model => (typeof model === 'string' ? model : model.id) === previousModel)) {
      updateLlmConnection(defaultTarget, { defaultModel: previousModel })
    }
    for (const workspace of config.workspaces) {
      const settings = loadWorkspaceConfig(workspace.rootPath)
      if (!settings?.defaults?.defaultLlmConnection) continue
      try { await copyFile(join(workspace.rootPath, 'config.json'), join(this.root, `workspace-${workspace.id}-before-routing.json`), constants.COPYFILE_EXCL) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      settings.defaults.defaultLlmConnection = target(settings.defaults.defaultLlmConnection)
      saveWorkspaceConfig(workspace.rootPath, settings)
    }
  }

  private ownedFlow(state: string, clientId: string): PendingOAuth {
    const flow = this.pending.get(state)
    if (!flow || flow.clientId !== clientId || flow.expires < Date.now()) throw new Error('Sign-in expired; start again')
    return flow
  }

  async command(command: CliProxyCommand, clientId: string): Promise<CliProxyResult> {
    await this.initialize()
    let oauth: CliProxyOAuthFlow | undefined
    let oauthStatus: CliProxyResult['oauthStatus']
    let imported: number | undefined
    switch (command.action) {
      case 'enable':
        this.state.enabled = true; this.restarts = 0; await this.saveState(); this.beginLaunch(); break
      case 'disable':
        this.state.enabled = false; await this.saveState(); this.child?.kill('SIGTERM'); this.phase = 'stopped'; break
      case 'routeAll': await this.routeAll(); break
      case 'setConnectorAccount': {
        const account = (await this.status()).accounts.find(account => account.id === command.id && account.provider === 'claude' && !account.disabled)
        if (!account) throw new Error('Enable this Claude account first')
        this.state.connectorAccountId = account.id; await this.saveState(); break
      }
      case 'importCraft': imported = await this.importCraftAccounts(); break
      case 'syncModels': await this.syncModels(); break
      case 'setAccountEnabled': {
        const account = (await this.status()).accounts.find(account => account.id === command.id)
        if (!account || typeof command.enabled !== 'boolean') throw new Error('Unknown account')
        await this.management('/credentials/status', 'PATCH', { name: account.id, disabled: !command.enabled })
        await this.syncModels(); break
      }
      case 'startOAuth': {
        if (!['claude', 'codex'].includes(command.provider)) throw new Error('Unsupported account provider')
        const result = await this.management('/oauth/auth-url', 'POST', { provider: command.provider, is_webui: false })
        const url = new URL(result.url)
        if (url.protocol !== 'https:' || !['claude.ai', 'auth.openai.com'].includes(url.hostname)) throw new Error('Unexpected sign-in destination')
        if (typeof result.state !== 'string' || !result.state) throw new Error('Missing sign-in state')
        this.pending.set(result.state, { provider: command.provider, clientId, expires: Date.now() + 300_000 })
        oauth = { provider: command.provider, url: url.toString(), state: result.state }; break
      }
      case 'completeOAuth': {
        const flow = this.ownedFlow(command.state, clientId)
        if (typeof command.code !== 'string' || command.code.length > 8192) throw new Error('Invalid sign-in callback')
        await this.management('/oauth/callback', 'POST', { provider: flow.provider, state: command.state, code: command.code, error: command.error })
        break
      }
      case 'oauthStatus': {
        this.ownedFlow(command.state, clientId)
        const result = await this.management(`/oauth/status?state=${encodeURIComponent(command.state)}`)
        oauthStatus = result.status === 'ok' ? 'ok' : result.status === 'wait' ? 'wait' : 'error'
        if (oauthStatus !== 'wait') { this.pending.delete(command.state); if (oauthStatus === 'ok') await this.syncModels() }
        break
      }
      case 'cancelOAuth':
        this.ownedFlow(command.state, clientId)
        await this.management(`/oauth/session?state=${encodeURIComponent(command.state)}`, 'DELETE')
        this.pending.delete(command.state); break
      default: throw new Error('Unknown account management action')
    }
    return { status: await this.status(), oauth, oauthStatus, imported }
  }
}

let singleton: CliProxyManager | undefined
export function getCliProxyManager(): CliProxyManager { return singleton ??= new CliProxyManager() }
