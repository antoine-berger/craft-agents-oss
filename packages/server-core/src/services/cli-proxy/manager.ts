import { createHash, randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'
import { addLlmConnection, getLlmConnection, getLlmConnections, updateLlmConnection } from '@craft-agent/shared/config'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { getValidClaudeOAuthToken } from '@craft-agent/shared/auth'
import type { CliProxyAccount, CliProxyCommand, CliProxyImportAccount, CliProxyOAuthFlow, CliProxyResult, CliProxyStatus } from '@craft-agent/shared/protocol'
import type { LlmConnection } from '@craft-agent/shared/config'
import { CLI_PROXY_VERSION, installCliProxy } from './install'

interface State { enabled: boolean; port: number }
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

  private async request(path: string, management: boolean, method = 'GET', body?: unknown): Promise<any> {
    const response = await fetch(`${this.baseUrl}${management ? '/v8/management' : ''}${path}`, {
      method, headers: { Authorization: `Bearer ${management ? this.managementKey : this.clientKey}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`Account service request failed (${response.status})`)
    return response.json()
  }

  private management(path: string, method = 'GET', body?: unknown): Promise<any> { return this.request(path, true, method, body) }

  async status(): Promise<CliProxyStatus> {
    await this.initialize()
    const status: CliProxyStatus = { ...this.state, running: this.phase === 'running', version: CLI_PROXY_VERSION,
      phase: this.phase, accounts: [], models: [], error: this.error }
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
      const auth = await getValidClaudeOAuthToken(connection.slug)
      const stored = await getCredentialManager().getLlmOAuth(connection.slug)
      if (auth.accessToken && stored) entries.push({ provider: 'claude', label: connection.name,
        accessToken: auth.accessToken, refreshToken: stored.refreshToken, expiresAt: stored.expiresAt,
        email: connection.oauthAccountEmail, accountId: connection.oauthAccountUuid })
    }
    return this.importAccounts(entries)
  }

  private async syncModels(): Promise<void> {
    const status = await this.status()
    for (const provider of ['claude', 'codex'] as const) {
      const models = status.models.filter(model => provider === 'claude' ? model.startsWith('claude-') : /^(gpt-|o[134](?:-|$))/.test(model))
      if (!models.length || !status.accounts.some(account => account.provider === provider && !account.disabled)) continue
      const slug = `cli-proxy-${provider}`
      const existing = getLlmConnection(slug)
      const connection: LlmConnection = {
        slug, name: provider === 'claude' ? 'Claude · Account pool' : 'GPT · Account pool',
        createdAt: existing?.createdAt ?? Date.now(),
        providerType: provider === 'claude' ? 'anthropic' : 'pi_compat', authType: 'api_key_with_endpoint',
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
