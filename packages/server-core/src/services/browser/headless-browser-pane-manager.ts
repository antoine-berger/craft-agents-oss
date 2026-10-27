/**
 * Browser automation owned by the headless server, not by a connected desktop.
 * Chromium communicates over Playwright's private pipe: no debugging port is opened.
 * Each session has a separate persistent profile. Browser processes are lazy, while
 * lifecycle IDs remain synchronous for the existing IBrowserPaneManager contract.
 */
import { createHash, randomUUID } from 'node:crypto'
import { access, chmod, mkdir, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { chromium, type BrowserContext, type CDPSession, type Download, type Page } from 'playwright-core'
import sharp from 'sharp'
import type { BrowserInstanceInfo, BrowserSecurityChallenge } from '@craft-agent/shared/protocol'
import {
  classifySecurityChallenge, countActionableAxNodes, noSecurityChallenge,
  SECURITY_CHALLENGE_CONFIRM_DELAY_MS, SECURITY_CHALLENGE_PAGE_SCRIPT,
  type SecurityChallengePageFacts,
} from '@craft-agent/shared/browser/security-challenge'
import type {
  IBrowserPaneManager, AccessibilityNode, AccessibilitySnapshot, BrowserClickResult,
  BrowserConsoleEntry, BrowserConsoleOptions, BrowserDownloadEntry, BrowserDownloadOptions,
  BrowserInstanceSnapshot, BrowserKeyArgs, BrowserNetworkEntry, BrowserNetworkOptions,
  BrowserScreenshotOptions, BrowserScreenshotRegionTarget, BrowserScreenshotResult,
  BrowserWaitArgs, BrowserWaitResult,
} from '../../handlers/browser-pane-manager-interface'

const MAX_LOGS = 500
const MAX_SNAPSHOT_NODES = 500
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024
const ACTION_TIMEOUT_MS = 15_000
const MAX_WAIT_MS = 60_000
const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'row', 'cell', 'columnheader', 'rowheader', 'gridcell'])
const CONTAINERS = new Set(['generic', 'none', 'rootwebarea', 'webarea'])
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms))
const bounded = (value: number | undefined, fallback: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? Math.floor(value!) : fallback))
const privateKey = (value: string) => createHash('sha256').update(value).digest('hex')

interface Box { x: number; y: number; width: number; height: number }
interface Geometry { ref: string; box: Box; clickPoint: { x: number; y: number } }
interface SessionContext {
  key: string
  sessionId: string
  workspaceId: string | null
  context?: BrowserContext
  launching?: Promise<BrowserContext>
  clipboard: string
  destroyed: boolean
  activeInstanceId?: string
}
interface Instance {
  id: string
  session: SessionContext
  boundSessionId: string | null
  ownerSessionId: string | null
  ownerType: 'session' | 'manual'
  agentControlActive: boolean
  page?: Page
  ready?: Promise<Page>
  cdp?: CDPSession
  viewport: { width: number; height: number }
  resizing?: Promise<void>
  destroyed: boolean
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  refs: Map<string, number>
  backendRefs: Map<number, string>
  refCounter: number
  console: BrowserConsoleEntry[]
  network: BrowserNetworkEntry[]
  inflight: Set<unknown>
  lastNetworkAt: number
  downloads: BrowserDownloadEntry[]
  downloadTasks: Set<Promise<void>>
  lastAction?: { kind: string; box?: Box; at: number }
}
export interface HeadlessBrowserPaneManagerOptions {
  /** Dedicated private directory; never point this at an existing user browser profile. */
  dataDir: string
  executablePath?: string
  chromiumSandbox?: boolean
  maxContexts?: number
  maxInstances?: number
  /** Only these session/workspace directories are uploadable. No implicit home-directory grant. */
  resolveUploadDirectories?: (sessionId: string, workspaceId: string | null) => string[] | Promise<string[]>
  log?: (message: string) => void
}

export class HeadlessBrowserPaneManager implements IBrowserPaneManager {
  readonly isHeadless = true
  private readonly options: HeadlessBrowserPaneManagerOptions
  private readonly contexts = new Map<string, SessionContext>()
  private readonly instances = new Map<string, Instance>()
  private readonly pendingClosures = new Set<Promise<void>>()
  private readonly closingContexts = new Map<string, Promise<void>>()
  private sessionPathResolver: (sessionId: string) => string | null = () => null
  private closed = false

  constructor(options: HeadlessBrowserPaneManagerOptions) {
    if (!isAbsolute(options.dataDir) || resolve(options.dataDir) === parseRoot(options.dataDir) || resolve(options.dataDir) === homedir()) {
      throw new Error('The server browser requires a dedicated absolute profile directory')
    }
    this.options = { ...options, dataDir: resolve(options.dataDir) }
  }

  setSessionPathResolver(fn: (sessionId: string) => string | null): void { this.sessionPathResolver = fn }

  private requireInstance(id: string): Instance {
    const instance = this.instances.get(id)
    if (!instance || instance.destroyed || instance.session.destroyed) throw new Error('This server browser no longer exists. Open a new browser first.')
    return instance
  }

  private sessionContext(sessionId: string, workspaceId: string | null = null): SessionContext {
    if (this.closed) throw new Error('The server browser is shutting down')
    if (!sessionId || sessionId.length > 512 || sessionId.includes('\0')) throw new Error('A valid session is required for the server browser')
    const key = privateKey(`${workspaceId ?? ''}\0${sessionId}`)
    const cached = this.contexts.get(key)
    if (cached && !cached.destroyed) return cached
    if (this.contexts.size >= (this.options.maxContexts ?? 8)) throw new Error('The server browser session limit has been reached. Close an existing browser session first.')
    const session: SessionContext = { key, sessionId, workspaceId, clipboard: '', destroyed: false }
    this.contexts.set(key, session)
    return session
  }

  private registerInstance(session: SessionContext, page?: Page): Instance {
    if (this.instances.size >= (this.options.maxInstances ?? 32)) throw new Error('The server browser window limit has been reached')
    const instance: Instance = {
      id: `server-browser-${randomUUID()}`, session,
      boundSessionId: session.sessionId, ownerSessionId: session.sessionId, ownerType: 'session', agentControlActive: false,
      viewport: { width: 1280, height: 900 }, destroyed: false,
      title: '', url: 'about:blank', loading: false, canGoBack: false, canGoForward: false,
      refs: new Map(), backendRefs: new Map(), refCounter: 0,
      console: [], network: [], inflight: new Set(), lastNetworkAt: Date.now(), downloads: [], downloadTasks: new Set(),
    }
    this.instances.set(instance.id, instance)
    session.activeInstanceId ??= instance.id
    if (page) this.attach(instance, page)
    return instance
  }

  private async launchContext(session: SessionContext): Promise<BrowserContext> {
    if (session.destroyed || this.closed) throw new Error('The server browser session has been closed')
    if (session.context) return session.context
    if (session.launching) return session.launching
    const launching = (async () => {
      await this.closingContexts.get(session.key)
      await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 })
      await chmod(this.options.dataDir, 0o700)
      const directory = join(this.options.dataDir, session.key)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700)
      const executablePath = this.options.executablePath ?? process.env.CRAFT_BROWSER_EXECUTABLE_PATH ?? chromium.executablePath()
      try { await access(executablePath, constants.X_OK) } catch {
        throw new Error('Server Chromium is not installed. Install the browser matching playwright-core, or set CRAFT_BROWSER_EXECUTABLE_PATH to a Chromium executable.')
      }
      let context: BrowserContext
      try {
        context = await chromium.launchPersistentContext(directory, {
          executablePath, headless: true, chromiumSandbox: this.options.chromiumSandbox ?? true,
          acceptDownloads: true, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1,
          timeout: 30_000,
        })
      } catch {
        throw new Error('Server Chromium could not start. Check its installed system dependencies, sandbox support, and exclusive profile access.')
      }
      if (session.destroyed || this.closed) { await context.close(); throw new Error('The server browser session was closed during startup') }
      // Persistent Chromium creates an initial blank page. Nothing from a user browser is attached.
      for (const page of context.pages()) await page.close()
      session.context = context
      context.on('close', () => { session.context = undefined; for (const instance of this.instances.values()) if (instance.session === session) this.forget(instance) })
      return context
    })()
    session.launching = launching
    try { return await launching } finally { if (session.launching === launching) session.launching = undefined }
  }

  private attach(instance: Instance, page: Page): void {
    instance.page = page
    page.setDefaultTimeout(ACTION_TIMEOUT_MS)
    page.setDefaultNavigationTimeout(30_000)
    page.on('close', () => this.forget(instance))
    page.on('crash', () => { this.options.log?.('A server browser tab crashed'); this.forget(instance) })
    page.on('framenavigated', frame => {
      if (frame !== page.mainFrame()) return
      instance.url = page.url(); instance.refs.clear(); instance.backendRefs.clear()
      void this.refresh(instance).catch(() => {})
    })
    page.on('domcontentloaded', () => { instance.loading = false; void this.refresh(instance).catch(() => {}) })
    page.on('load', () => { instance.loading = false; void this.refresh(instance).catch(() => {}) })
    page.on('console', event => {
      const type = event.type()
      const level = type === 'warning' ? 'warn' : ['log', 'info', 'warn', 'error'].includes(type) ? type as BrowserConsoleEntry['level'] : 'log'
      instance.console.push({ timestamp: Date.now(), level, message: event.text().slice(0, 16_384) })
      if (instance.console.length > MAX_LOGS) instance.console.splice(0, instance.console.length - MAX_LOGS)
    })
    page.on('pageerror', error => {
      instance.console.push({ timestamp: Date.now(), level: 'error', message: error.message.slice(0, 16_384) })
      if (instance.console.length > MAX_LOGS) instance.console.shift()
    })
    page.on('request', request => { instance.inflight.add(request); instance.lastNetworkAt = Date.now() })
    page.on('requestfinished', request => { instance.inflight.delete(request); instance.lastNetworkAt = Date.now() })
    page.on('requestfailed', request => {
      instance.inflight.delete(request); instance.lastNetworkAt = Date.now()
      this.networkEntry(instance, { timestamp: Date.now(), method: request.method(), url: request.url(), status: 0, resourceType: request.resourceType(), ok: false })
    })
    page.on('response', response => {
      const request = response.request()
      this.networkEntry(instance, { timestamp: Date.now(), method: request.method(), url: response.url(), status: response.status(), resourceType: request.resourceType(), ok: response.ok() })
    })
    page.on('download', download => this.recordDownload(instance, download))
    page.on('popup', popup => {
      if (instance.destroyed || instance.session.destroyed) { void popup.close(); return }
      try {
        const opened = this.registerInstance(instance.session, popup)
        instance.session.activeInstanceId = opened.id
      } catch { void popup.close() }
    })
    // Dialogs are dismissed by Playwright's default. Agents must not accidentally accept prompts.
  }

  private networkEntry(instance: Instance, entry: BrowserNetworkEntry): void {
    instance.network.push(entry)
    if (instance.network.length > MAX_LOGS) instance.network.splice(0, instance.network.length - MAX_LOGS)
  }

  private async page(id: string): Promise<Page> {
    const instance = this.requireInstance(id)
    if (instance.page && !instance.page.isClosed()) { if (instance.resizing) await instance.resizing; return instance.page }
    if (!instance.ready) {
      instance.ready = (async () => {
        const context = await this.launchContext(instance.session)
        const page = await context.newPage()
        if (instance.destroyed || instance.session.destroyed) { await page.close(); throw new Error('This server browser has been closed') }
        this.attach(instance, page)
        await page.setViewportSize(instance.viewport)
        return page
      })()
    }
    try { return await instance.ready } catch (error) { instance.ready = undefined; throw error }
  }

  private async cdp(id: string): Promise<CDPSession> {
    const instance = this.requireInstance(id)
    const page = await this.page(id)
    instance.cdp ??= await page.context().newCDPSession(page)
    return instance.cdp
  }

  private async refresh(instance: Instance): Promise<void> {
    if (!instance.page || instance.page.isClosed() || instance.destroyed) return
    instance.url = instance.page.url()
    instance.title = await instance.page.title().catch(() => instance.title)
    const cdp = await this.cdp(instance.id)
    const history = await cdp.send('Page.getNavigationHistory')
    instance.canGoBack = history.currentIndex > 0
    instance.canGoForward = history.currentIndex < history.entries.length - 1
  }

  getOrCreateForSession(sessionId: string, options?: { workspaceId?: string | null }): string {
    return this.createForSession(sessionId, options)
  }
  async getOrCreateForSessionAsync(sessionId: string, options?: { workspaceId?: string | null }): Promise<string> {
    const id = this.getOrCreateForSession(sessionId, options); await this.page(id); return id
  }
  createForSession(sessionId: string, options?: { show?: boolean; workspaceId?: string | null }): string {
    // SessionManager resolves the target for every command through this method.
    // Match Electron: creating for an already-bound session reuses its page.
    const knownSession = options?.workspaceId === undefined
      ? [...this.contexts.values()].find(context => context.sessionId === sessionId && !context.destroyed)
      : undefined
    const session = knownSession ?? this.sessionContext(sessionId, options?.workspaceId ?? null)
    const active = session.activeInstanceId ? this.instances.get(session.activeInstanceId) : undefined
    const existing = active && !active.destroyed && (active.boundSessionId === sessionId || active.boundSessionId === null)
      ? active
      : [...this.instances.values()].find(instance => instance.session === session && !instance.destroyed && instance.boundSessionId === sessionId)
      ?? [...this.instances.values()].find(instance => instance.session === session && !instance.destroyed && instance.boundSessionId === null)
    if (existing) {
      this.bindSession(existing.id, sessionId, options)
      return existing.id
    }
    return this.registerInstance(session).id
  }
  async createForSessionAsync(sessionId: string, options?: { show?: boolean; workspaceId?: string | null }): Promise<string> {
    const id = this.createForSession(sessionId, options); await this.page(id); return id
  }
  focusBoundForSession(sessionId: string, options?: { workspaceId?: string | null }): string { const id = this.getOrCreateForSession(sessionId, options); this.focus(id); return id }
  async focusBoundForSessionAsync(sessionId: string, options?: { workspaceId?: string | null }): Promise<string> { const id = await this.getOrCreateForSessionAsync(sessionId, options); await (await this.page(id)).bringToFront(); return id }
  focus(id: string): void {
    const instance = this.requireInstance(id)
    instance.session.activeInstanceId = id
    if (instance.page) void instance.page.bringToFront().catch(() => {})
  }
  hide(id: string): void { this.requireInstance(id) /* Headless pages have no desktop visibility. */ }
  bindSession(id: string, sessionId: string, options?: { workspaceId?: string | null }): void {
    const instance = this.requireInstance(id)
    if (instance.session.sessionId !== sessionId || (options?.workspaceId != null && options.workspaceId !== instance.session.workspaceId)) throw new Error('A server browser profile cannot be rebound to another session or workspace')
    instance.boundSessionId = sessionId; instance.ownerSessionId = sessionId; instance.ownerType = 'session'
  }
  unbindAllForSession(sessionId: string): void {
    for (const instance of this.instances.values()) if (instance.boundSessionId === sessionId) {
      // Retain the last owner so post-turn lifecycle commands can still close it.
      instance.boundSessionId = null; instance.ownerType = 'manual'; instance.agentControlActive = false
    }
  }
  setAgentControl(sessionId: string, _meta: { displayName?: string; intent?: string }, _options?: { workspaceId?: string | null }): void {
    for (const instance of this.instances.values()) if (instance.boundSessionId === sessionId) instance.agentControlActive = true
  }
  clearAgentControl(sessionId: string): void { for (const instance of this.instances.values()) if (instance.ownerSessionId === sessionId) instance.agentControlActive = false }
  clearAgentControlForInstance(id: string, sessionId?: string): { released: boolean; reason?: string } {
    const instance = this.instances.get(id)
    if (!instance || (sessionId && instance.ownerSessionId !== sessionId)) return { released: false, reason: 'The browser is not owned by this session' }
    instance.agentControlActive = false; return { released: true }
  }
  async clearVisualsForSession(sessionId: string): Promise<void> { this.clearAgentControl(sessionId) }
  getInstance(id: string): BrowserInstanceSnapshot | undefined {
    const instance = this.instances.get(id)
    return !instance || instance.destroyed ? undefined : { ownerType: instance.ownerType, ownerSessionId: instance.ownerSessionId, isVisible: false, title: instance.title, currentUrl: instance.url }
  }
  async getInstanceAsync(id: string): Promise<BrowserInstanceSnapshot | undefined> {
    const instance = this.instances.get(id); if (!instance || instance.destroyed) return undefined
    if (instance.page) await this.refresh(instance)
    return this.getInstance(id)
  }
  listInstances(): BrowserInstanceInfo[] {
    return [...this.instances.values()].filter(instance => !instance.destroyed).map(instance => ({
      id: instance.id, url: instance.url, title: instance.title, favicon: null, isLoading: instance.loading,
      canGoBack: instance.canGoBack, canGoForward: instance.canGoForward,
      boundSessionId: instance.boundSessionId, ownerType: instance.ownerType, ownerSessionId: instance.ownerSessionId,
      isVisible: false, agentControlActive: instance.agentControlActive, themeColor: null, workspaceId: instance.session.workspaceId,
    }))
  }
  async listInstancesAsync(): Promise<BrowserInstanceInfo[]> {
    await Promise.all([...this.instances.values()].filter(instance => instance.page).map(instance => this.refresh(instance).catch(() => {})))
    return this.listInstances()
  }
  private forget(instance: Instance): void {
    instance.destroyed = true
    instance.refs.clear()
    instance.backendRefs.clear()
    this.instances.delete(instance.id)
    if (instance.session.activeInstanceId === instance.id) instance.session.activeInstanceId = undefined
  }
  private closing(task: Promise<void>): void {
    this.pendingClosures.add(task)
    void task.catch(() => {}).finally(() => this.pendingClosures.delete(task))
  }
  destroyInstance(id: string): void {
    const instance = this.instances.get(id); if (!instance) return
    this.forget(instance)
    if (instance.page) this.closing(instance.page.close())
    if (![...this.instances.values()].some(other => other.session === instance.session)) this.closeContext(instance.session)
  }
  private closeContext(session: SessionContext): void {
    session.destroyed = true
    this.contexts.delete(session.key)
    for (const instance of this.instances.values()) if (instance.session === session) this.forget(instance)
    const closure = (async () => {
      const context = session.context ?? await session.launching?.catch(() => undefined)
      await context?.close()
    })()
    this.closingContexts.set(session.key, closure)
    this.closing(closure)
    void closure.catch(() => {}).finally(() => {
      if (this.closingContexts.get(session.key) === closure) this.closingContexts.delete(session.key)
    })
  }
  destroyForSession(sessionId: string): void {
    for (const session of this.contexts.values()) if (session.sessionId === sessionId) {
      this.closeContext(session)
    }
  }
  /** Graceful server shutdown closes only Chromium processes launched by this manager; profiles remain. */
  async close(): Promise<void> {
    this.closed = true
    for (const session of [...this.contexts.values()]) this.destroyForSession(session.sessionId)
    await Promise.allSettled([...this.pendingClosures])
  }

  async navigate(id: string, value: string): Promise<{ url: string; title: string }> {
    let url: URL
    try { url = new URL(value) } catch { throw new Error('Navigate requires an absolute http or https URL') }
    if (!['http:', 'https:'].includes(url.protocol) && value !== 'about:blank') throw new Error('The server browser only navigates to http, https, or about:blank URLs')
    if (url.username || url.password) throw new Error('Credentials in browser URLs are not supported; use the site sign-in form')
    const instance = this.requireInstance(id); const page = await this.page(id)
    instance.loading = true
    try { await page.goto(url.href, { waitUntil: 'domcontentloaded' }); await this.refresh(instance); return { url: instance.url, title: instance.title } }
    finally { instance.loading = false }
  }
  async goBack(id: string): Promise<void> { const page = await this.page(id); await page.goBack({ waitUntil: 'domcontentloaded' }); await this.refresh(this.requireInstance(id)) }
  async goForward(id: string): Promise<void> { const page = await this.page(id); await page.goForward({ waitUntil: 'domcontentloaded' }); await this.refresh(this.requireInstance(id)) }

  async getAccessibilitySnapshot(id: string): Promise<AccessibilitySnapshot> {
    const instance = this.requireInstance(id); const cdp = await this.cdp(id)
    const result = await cdp.send('Accessibility.getFullAXTree')
    instance.refs.clear()
    const nodes: AccessibilityNode[] = []
    for (const raw of result.nodes) {
      if (raw.ignored) continue
      const role = String(raw.role?.value ?? '').toLowerCase()
      const name = String(raw.name?.value ?? '').trim()
      const properties = new Map<string, unknown>((raw.properties ?? []).map(property => [property.name, property.value?.value]))
      if (CONTAINERS.has(role) || (!name && !INTERACTIVE.has(role) && raw.value?.value == null)) continue
      const backend = raw.backendDOMNodeId
      let ref = backend == null ? undefined : instance.backendRefs.get(backend)
      ref ??= `@e${++instance.refCounter}`
      if (backend != null) { instance.refs.set(ref, backend); instance.backendRefs.set(backend, ref) }
      const node: AccessibilityNode = { ref, role, name }
      if (raw.value?.value != null && !properties.get('protected')) {
        let password = false
        if (backend != null && role === 'textbox') {
          const element = await cdp.send('DOM.describeNode', { backendNodeId: backend }).catch(() => null)
          const attributes = element?.node.attributes ?? []
          for (let index = 0; index < attributes.length; index += 2) {
            if (attributes[index] === 'type' && attributes[index + 1]?.toLowerCase() === 'password') password = true
          }
        }
        if (!password) node.value = String(raw.value.value)
      }
      if (raw.description?.value) node.description = String(raw.description.value)
      if (properties.get('focused')) node.focused = true
      if (properties.get('disabled')) node.disabled = true
      if (properties.get('checked') === true || properties.get('checked') === 'true') node.checked = true
      nodes.push(node)
      if (nodes.length >= MAX_SNAPSHOT_NODES) break
    }
    await this.refresh(instance)
    return { url: instance.url, title: instance.title, nodes }
  }

  private async element<T>(id: string, ref: string, functionDeclaration: string, args: unknown[] = []): Promise<T> {
    const instance = this.requireInstance(id)
    const backend = instance.refs.get(ref)
    if (backend == null) throw new Error(`Element ${ref} is unavailable. Run browser_snapshot to get current refs.`)
    const cdp = await this.cdp(id)
    let objectId: string | undefined
    try {
      const resolved = await cdp.send('DOM.resolveNode', { backendNodeId: backend })
      objectId = resolved.object.objectId
      if (!objectId) throw new Error('The element is no longer present')
      const result = await cdp.send('Runtime.callFunctionOn', { objectId, functionDeclaration, arguments: args.map(value => ({ value })), returnByValue: true, awaitPromise: true, userGesture: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      return result.result.value as T
    } catch (cause) {
      if (cause instanceof Error && /Could not find|Cannot find|No node|context was destroyed|no longer/.test(cause.message)) throw new Error(`Element ${ref} is stale. Run browser_snapshot again.`)
      throw cause
    } finally { if (objectId) await cdp.send('Runtime.releaseObject', { objectId }).catch(() => {}) }
  }

  private async geometry(id: string, ref: string, scroll = true): Promise<Geometry> {
    const box = await this.element<Box>(id, ref, `function(scroll){
      if(!this.isConnected || !(this instanceof Element)) throw new Error('Element is no longer present');
      if(scroll)this.scrollIntoView({block:'center',inline:'center'});
      const r=this.getBoundingClientRect();
      if(r.width<=0||r.height<=0) throw new Error('Element is not visible');
      const x=Math.max(0,r.left),y=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);
      if(right<=x||bottom<=y) throw new Error('Element is outside the viewport');
      return {x,y,width:right-x,height:bottom-y};
    }`, [scroll])
    return { ref, box, clickPoint: { x: box.x + box.width / 2, y: box.y + box.height / 2 } }
  }
  async clickElement(id: string, ref: string, options?: { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number }): Promise<BrowserClickResult> {
    const instance = this.requireInstance(id); const page = await this.page(id); const geometry = await this.geometry(id, ref)
    const actionable = await this.element<boolean>(id, ref, `function(x,y){const hit=document.elementFromPoint(x,y);return !this.disabled&&this.getAttribute('aria-disabled')!=='true'&&!!hit&&(hit===this||this.contains(hit));}`, [geometry.clickPoint.x, geometry.clickPoint.y])
    if (!actionable) throw new Error('The element is disabled or covered by another element')
    const timeout = bounded(options?.timeoutMs, ACTION_TIMEOUT_MS, 100, MAX_WAIT_MS)
    const popup = page.waitForEvent('popup', { timeout: Math.min(timeout, 300) }).catch(() => null)
    const navigation = options?.waitFor === 'navigation' ? page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout }) : null
    if (navigation) void navigation.catch(() => {})
    await page.mouse.click(geometry.clickPoint.x, geometry.clickPoint.y)
    instance.lastAction = { kind: 'click', box: geometry.box, at: Date.now() }
    if (navigation) await navigation
    if (options?.waitFor === 'network-idle') await this.waitFor(id, { kind: 'network-idle', timeoutMs: timeout })
    const opened = await popup
    await this.refresh(instance)
    const popupInstance = opened ? [...this.instances.values()].find(item => item.page === opened) : undefined
    return { via: 'mouse', ...(popupInstance ? { popup: popupInstance.id } : {}) }
  }
  async clickAtCoordinates(id: string, x: number, y: number): Promise<void> {
    const instance = this.requireInstance(id); const page = await this.page(id)
    this.assertPoint(instance, x, y); await page.mouse.click(x, y)
    instance.lastAction = { kind: 'click', box: { x: x - 4, y: y - 4, width: 8, height: 8 }, at: Date.now() }
  }
  private assertPoint(instance: Instance, x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > instance.viewport.width || y > instance.viewport.height) throw new Error('Browser coordinates must be inside the viewport')
  }
  async drag(id: string, x1: number, y1: number, x2: number, y2: number): Promise<void> {
    const instance = this.requireInstance(id); const page = await this.page(id)
    this.assertPoint(instance, x1, y1); this.assertPoint(instance, x2, y2)
    await page.mouse.move(x1, y1); await page.mouse.down()
    try { await page.mouse.move(x2, y2, { steps: 12 }) } finally { await page.mouse.up() }
    instance.lastAction = { kind: 'drag', box: { x: Math.min(x1,x2), y: Math.min(y1,y2), width: Math.max(2,Math.abs(x2-x1)), height: Math.max(2,Math.abs(y2-y1)) }, at: Date.now() }
  }
  async fillElement(id: string, ref: string, value: string): Promise<void> {
    await this.element(id, ref, `function(value){
      if(!this.isConnected) throw new Error('Element is no longer present');
      if(this.disabled||this.readOnly||this.getAttribute('aria-disabled')==='true') throw new Error('The field is disabled or read-only');
      this.focus();
      if(this.isContentEditable){this.textContent=value;this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));return;}
      const proto=this instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:this instanceof HTMLInputElement?HTMLInputElement.prototype:null;
      if(!proto||['file','checkbox','radio','button','submit'].includes(this.type))throw new Error('This element is not a text field');
      Object.getOwnPropertyDescriptor(proto,'value').set.call(this,value);
      this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));
    }`, [value])
    this.requireInstance(id).lastAction = { kind: 'fill', at: Date.now() }
  }
  async typeText(id: string, text: string): Promise<void> { await (await this.page(id)).keyboard.insertText(text); this.requireInstance(id).lastAction = { kind: 'type', at: Date.now() } }
  async selectOption(id: string, ref: string, value: string): Promise<void> {
    const native = await this.element<boolean>(id, ref, `function(value){
      if(!(this instanceof HTMLSelectElement))return false;
      if(this.disabled)throw new Error('The select is disabled');
      const option=Array.from(this.options).find(o=>o.value===value||o.label===value||o.text===value);
      if(!option||option.disabled)throw new Error('The requested option is unavailable');
      this.value=option.value;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return true;
    }`, [value])
    if (native) return
    await this.clickElement(id, ref)
    const snapshot = await this.getAccessibilitySnapshot(id)
    const option = snapshot.nodes.find(node => ['option','menuitem','menuitemradio'].includes(node.role) && node.name === value && !node.disabled)
    if (!option) throw new Error('The requested option is not visible. Run browser_snapshot and select a visible option.')
    await this.clickElement(id, option.ref)
  }
  async setClipboard(id: string, text: string): Promise<void> { this.requireInstance(id).session.clipboard = text }
  async getClipboard(id: string): Promise<string> { return this.requireInstance(id).session.clipboard }
  async scroll(id: string, direction: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<void> {
    const page = await this.page(id); const pixels = bounded(amount, 600, 1, 100_000)
    if (!['up','down','left','right'].includes(direction)) throw new Error('Unknown scroll direction')
    await page.mouse.wheel(direction === 'left' ? -pixels : direction === 'right' ? pixels : 0, direction === 'up' ? -pixels : direction === 'down' ? pixels : 0)
  }
  async sendKey(id: string, args: BrowserKeyArgs): Promise<void> {
    const page = await this.page(id); const instance = this.requireInstance(id)
    const aliases: Record<string,string> = { Return:'Enter', Esc:'Escape', ArrowUp:'ArrowUp', ArrowDown:'ArrowDown', ArrowLeft:'ArrowLeft', ArrowRight:'ArrowRight', Del:'Delete', Space:'Space' }
    const modifierNames = { shift:'Shift', control:'Control', alt:'Alt', meta:'Meta' }
    const modifiers = (args.modifiers ?? []).map(modifier => modifierNames[modifier])
    if (modifiers.some(modifier => !modifier) || !args.key || args.key.length > 100) throw new Error('Invalid browser key')
    const key = aliases[args.key] ?? args.key
    const command = modifiers.includes('Control') || modifiers.includes('Meta')
    if (command && key.toLowerCase() === 'v') { await page.keyboard.insertText(instance.session.clipboard); return }
    if (command && ['c','x'].includes(key.toLowerCase())) {
      instance.session.clipboard = await page.evaluate(`(()=>{const e=document.activeElement;if(e&&e.type==='password')return '';return e&&typeof e.selectionStart==='number'?e.value.slice(e.selectionStart,e.selectionEnd):String(getSelection()||'')})()`)
      if (key.toLowerCase() === 'x') await page.keyboard.press('Backspace')
      return
    }
    await page.keyboard.press([...modifiers, key].join('+'))
  }

  async uploadFile(id: string, ref: string, filePaths: string[]): Promise<{ ref: string; files: number }> {
    const instance = this.requireInstance(id)
    if (!Array.isArray(filePaths) || filePaths.length > 100 || filePaths.some(path => typeof path !== 'string' || !path)) throw new Error('Upload requires a list of server file paths')
    const roots = [...(await this.options.resolveUploadDirectories?.(instance.session.sessionId, instance.session.workspaceId) ?? []), this.sessionPathResolver(instance.session.sessionId)].filter((path): path is string => !!path)
    const canonicalRoots = await Promise.all(roots.map(async path => { if (!isAbsolute(path)) throw new Error('Upload roots must be absolute'); return realpath(path) }))
    if (!canonicalRoots.length) throw new Error('No upload directory is available for this session')
    const profileRoot = await realpath(this.options.dataDir)
    const files: string[] = []
    let total = 0
    for (const candidate of filePaths) {
      if (!isAbsolute(candidate)) throw new Error('Upload paths must be absolute server file paths')
      const file = await realpath(candidate)
      if (!canonicalRoots.some(root => inside(file, root)) || inside(file, profileRoot)) throw new Error('The upload file is outside this session’s allowed directories')
      if (/(^|[\\/])(?:\.ssh|\.gnupg|\.aws|\.claude|\.codex)(?:[\\/]|$)|(?:^|[\\/])\.env(?:[.\\/]|$)|(?:credentials|secrets?|auth)\.(?:json|ya?ml|toml|enc)$|\.(?:pem|key)$/i.test(file)) throw new Error('Sensitive credential files cannot be uploaded by the browser')
      const info = await stat(file)
      if (!info.isFile()) throw new Error('Only regular files can be uploaded')
      total += info.size
      if (total > MAX_UPLOAD_BYTES) throw new Error('The upload exceeds the server browser size limit')
      files.push(file)
    }
    const backend = instance.refs.get(ref)
    if (backend == null) throw new Error('Run browser_snapshot before selecting a file input')
    await (await this.cdp(id)).send('DOM.setFileInputFiles', { backendNodeId: backend, files })
    return { ref, files: files.length }
  }
  async evaluate(id: string, expression: string): Promise<unknown> {
    if (typeof expression !== 'string' || expression.length > 1_000_000) throw new Error('Browser script exceeds the size limit')
    return (await this.page(id)).evaluate(expression)
  }

  windowResize(id: string, width: number, height: number): { width: number; height: number } {
    const instance = this.requireInstance(id)
    const viewport = { width: bounded(width,1280,320,3840), height: bounded(height,900,240,2160) }
    instance.viewport = viewport
    if (instance.page) {
      instance.resizing = (instance.resizing ?? Promise.resolve()).catch(() => {}).then(() => instance.page?.setViewportSize(viewport))
      void instance.resizing.catch(() => {})
    }
    return viewport
  }
  async screenshot(id: string, options: BrowserScreenshotOptions = {}): Promise<BrowserScreenshotResult> {
    const instance = this.requireInstance(id)
    const page = await this.page(id)
    const mode = options.annotate || options.mode === 'agent' ? 'agent' : 'raw'
    const format = options.format ?? (mode === 'agent' ? 'jpeg' : 'png')
    const warnings: string[] = []
    const targets: Array<Geometry & { role?: string; name?: string }> = []
    const snapshot = options.annotate ? await this.getAccessibilitySnapshot(id) : undefined
    const refs = snapshot?.nodes.map(node => node.ref) ?? options.refs ?? []
    for (const ref of refs) {
      try {
        // Screenshots must not scroll the page while collecting on-screen annotations.
        const geometry = await this.geometry(id, ref, false)
        const node = snapshot?.nodes.find(node => node.ref === ref)
        targets.push({ ...geometry, role: node?.role, name: node?.name })
        if (targets.length === 100) {
          warnings.push('Annotation capped at 100 visible elements')
          break
        }
      } catch {
        if (!options.annotate) warnings.push(`Could not resolve ref ${ref}; run browser_snapshot for current refs`)
      }
    }
    let buffer = await page.screenshot({
      type: format,
      ...(format === 'jpeg' ? { quality: bounded(options.jpegQuality, 80, 1, 100) } : {}),
      animations: 'disabled',
    })
    const showTargets = options.annotate || mode === 'agent'
    if (showTargets && (targets.length || (options.includeLastAction && instance.lastAction?.box))) {
      const rectangle = (box: Box, color: string) => `<rect x="${Math.max(0, box.x)}" y="${Math.max(0, box.y)}" width="${box.width}" height="${box.height}" fill="none" stroke="${color}" stroke-width="2"/>`
      const shapes = targets.map(target => {
        const x = Math.max(0, target.box.x)
        const y = Math.max(15, target.box.y)
        return rectangle(target.box, '#ec4899')
          + `<rect x="${x}" y="${y - 15}" width="50" height="15" fill="#be185d"/>`
          + `<text x="${x + 2}" y="${y - 3}" font-family="sans-serif" font-size="12" fill="white">${target.ref}</text>`
      })
      if (options.includeLastAction && instance.lastAction?.box) shapes.push(rectangle(instance.lastAction.box, '#22d3ee'))
      const overlay = Buffer.from(`<svg width="${instance.viewport.width}" height="${instance.viewport.height}" xmlns="http://www.w3.org/2000/svg">${shapes.join('')}</svg>`)
      const pipeline = sharp(buffer).composite([{ input: overlay }])
      buffer = format === 'jpeg'
        ? await pipeline.jpeg({ quality: bounded(options.jpegQuality, 80, 1, 100) }).toBuffer()
        : await pipeline.png().toBuffer()
    }
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Screenshot is too large; resize the browser or request a region')
    const action = options.includeLastAction && instance.lastAction
      ? { tool: `browser_${instance.lastAction.kind}`, status: 'success', timestamp: instance.lastAction.at }
      : undefined
    return {
      imageBuffer: buffer,
      imageFormat: format,
      ...(options.includeMetadata || mode === 'agent' || warnings.length ? {
        metadata: {
          headless: true, mode, url: page.url(), viewport: { ...instance.viewport, dpr: 1 }, targets, action,
          ...(warnings.length ? { warnings } : {}),
        },
      } : {}),
    }
  }
  async screenshotRegion(id: string, target: BrowserScreenshotRegionTarget): Promise<BrowserScreenshotResult> {
    const instance = this.requireInstance(id); const page = await this.page(id)
    let box: Box
    if (target.ref) box = (await this.geometry(id,target.ref)).box
    else if (target.selector) {
      const locator=page.locator(target.selector).first();await locator.scrollIntoViewIfNeeded();const bounds=await locator.boundingBox()
      if (!bounds) throw new Error('The screenshot target is not visible');box=bounds
    } else {
      if (![target.x,target.y,target.width,target.height].every(value=>typeof value==='number'&&Number.isFinite(value))) throw new Error('Screenshot region requires coordinates and size')
      box={x:target.x!,y:target.y!,width:target.width!,height:target.height!}
    }
    const padding=bounded(target.padding,0,0,200)
    const left=Math.max(0,Math.floor(box.x-padding)),top=Math.max(0,Math.floor(box.y-padding))
    const right=Math.min(instance.viewport.width,Math.ceil(box.x+box.width+padding)),bottom=Math.min(instance.viewport.height,Math.ceil(box.y+box.height+padding))
    if(right<=left||bottom<=top)throw new Error('The screenshot region is outside the viewport')
    const input=await page.screenshot({type:'png',animations:'disabled'})
    const cropped=sharp(input).extract({left,top,width:right-left,height:bottom-top})
    const format=target.format??'png'
    const imageBuffer=format==='jpeg'?await cropped.jpeg({quality:bounded(target.jpegQuality,80,1,100)}).toBuffer():await cropped.png().toBuffer()
    return {imageBuffer,imageFormat:format,metadata:{headless:true,region:{x:left,y:top,width:right-left,height:bottom-top}}}
  }

  getConsoleLogs(id: string, options: BrowserConsoleOptions = {}): BrowserConsoleEntry[] {
    const list=this.requireInstance(id).console
    return list.filter(entry=>!options.level||options.level==='all'||entry.level===options.level).slice(-bounded(options.limit,50,1,MAX_LOGS))
  }
  getNetworkLogs(id: string, options: BrowserNetworkOptions = {}): BrowserNetworkEntry[] {
    return this.requireInstance(id).network.filter(entry=>{
      if(options.method&&entry.method!==options.method.toUpperCase())return false
      if(options.resourceType&&entry.resourceType!==options.resourceType.toLowerCase())return false
      if(!options.status||options.status==='all')return true
      if(options.status==='failed')return !entry.ok
      return Math.floor(entry.status/100)===Number(options.status[0])
    }).slice(-bounded(options.limit,50,1,MAX_LOGS))
  }
  async waitFor(id: string, args: BrowserWaitArgs): Promise<BrowserWaitResult> {
    const page=await this.page(id),instance=this.requireInstance(id),started=Date.now()
    const timeout=bounded(args.timeoutMs,ACTION_TIMEOUT_MS,100,MAX_WAIT_MS),poll=bounded(args.pollMs,50,25,1000),idle=bounded(args.idleMs,700,100,10_000)
    if(!['selector','text','url','network-idle'].includes(args.kind))throw new Error('Unknown browser wait condition')
    if(args.kind!=='network-idle'&&!args.value?.trim())throw new Error(`Browser wait ${args.kind} requires a value`)
    while(Date.now()-started<=timeout){
      let matched=false
      if(args.kind==='selector')matched=await page.locator(args.value!).count()>0
      else if(args.kind==='text')matched=await page.evaluate(`Boolean(document.body && document.body.innerText.includes(${JSON.stringify(args.value)}))`)
      else if(args.kind==='url')matched=page.url().includes(args.value!)
      else matched=instance.inflight.size===0&&Date.now()-instance.lastNetworkAt>=idle
      if(matched)return {ok:true,kind:args.kind,elapsedMs:Date.now()-started,detail:args.kind==='network-idle'?`network idle for ${idle}ms`:`${args.kind} matched: ${args.value}`}
      await sleep(poll)
    }
    throw new Error(`Wait timed out after ${timeout}ms (${args.kind})`)
  }

  private recordDownload(instance: Instance, download: Download): void {
    const entry: BrowserDownloadEntry={id:randomUUID(),timestamp:Date.now(),url:download.url(),filename:basename(download.suggestedFilename()).slice(0,200)||'download',state:'in-progress',bytesReceived:0,totalBytes:0,mimeType:'application/octet-stream'}
    instance.downloads.push(entry)
    if(instance.downloads.length>MAX_LOGS)instance.downloads.shift()
    const task=(async()=>{
      try{
        const sessionDir=this.sessionPathResolver(instance.session.sessionId)
        if(!sessionDir||!isAbsolute(sessionDir))throw new Error('No session download directory')
        const directory=join(sessionDir,'downloads','browser');await mkdir(directory,{recursive:true,mode:0o700})
        if (!inside(await realpath(directory), await realpath(sessionDir))) throw new Error('Download directory escapes session storage')
        const path=join(directory,`${entry.id}-${entry.filename.replace(/[^\w. -]/g,'_')}`)
        await download.saveAs(path);await chmod(path,0o600)
        const failure=await download.failure();if(failure)throw new Error('Download interrupted')
        const info=await stat(path)
        entry.savePath=path;entry.bytesReceived=info.size;entry.totalBytes=info.size;entry.state='completed'
      }catch{entry.state='interrupted'}
    })()
    instance.downloadTasks.add(task);void task.finally(()=>instance.downloadTasks.delete(task))
  }
  async getDownloads(id: string, options: BrowserDownloadOptions = {}): Promise<BrowserDownloadEntry[]> {
    const instance=this.requireInstance(id);await this.page(id)
    if(options.action==='wait'){
      const started=Date.now(),timeout=bounded(options.timeoutMs,ACTION_TIMEOUT_MS,100,MAX_WAIT_MS)
      while(Date.now()-started<timeout&&!instance.downloads.some(entry=>entry.state!=='in-progress'))await sleep(50)
    }
    return instance.downloads.slice(-bounded(options.limit,20,1,200)).map(entry=>({...entry}))
  }
  private async challengeFacts(id: string): Promise<BrowserSecurityChallenge> {
    const instance=this.requireInstance(id),page=await this.page(id),url=page.url()
    if(instance.loading)return noSecurityChallenge()
    const facts=await page.evaluate(SECURITY_CHALLENGE_PAGE_SCRIPT).catch(()=>null) as SecurityChallengePageFacts|null
    const snapshot=await this.getAccessibilitySnapshot(id).catch(()=>null)
    try {
      return classifySecurityChallenge({url,loading:instance.loading,urlChanged:page.url()!==url,page:facts,ax:snapshot?{nodes:snapshot.nodes.length,actionable:countActionableAxNodes(snapshot.nodes)}:null})
    } catch {
      // Page scripts can patch built-ins and return malformed facts; match desktop behavior.
      return noSecurityChallenge()
    }
  }
  async detectSecurityChallenge(id: string): Promise<BrowserSecurityChallenge> {
    let verdict=await this.challengeFacts(id)
    if(verdict.detected){await sleep(SECURITY_CHALLENGE_CONFIRM_DELAY_MS);verdict=await this.challengeFacts(id)}
    return verdict
  }
}

function inside(path: string, directory: string): boolean {
  const child=relative(directory,path)
  return child===''||(!child.startsWith(`..${sep}`)&&child!=='..'&&!isAbsolute(child))
}
function parseRoot(path: string): string { return resolve(path).split(sep)[0]+sep }
