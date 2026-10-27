import type { AttentionReason, AttentionSource, WorkspaceAttention } from '../../../../shared/src/protocol/session-attention'
import type { PrWatchRegistry } from '../pr-watch/registry'
import type { ISessionManager } from '../../handlers/session-manager-interface'
import { SessionAttentionStore } from './store'
import { reconcileGithubAttention } from './github'
import { findShipState } from '../ship-workflow/store'

const CLIENT = '__session_attention__'
/** Persistent server-owned attention for every non-archived session, independent of open projects/windows. */
export class SessionAttentionService {
  private stores = new Map<string, SessionAttentionStore>()
  private subscriptions = new Map<string, { id: string; dir: string }>()
  private registry: PrWatchRegistry | null = null
  private stopRegistry: (() => void) | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  private reconciling: Promise<void> | null = null
  private disposed = false
  private activeAutoFix = new Map<string, string>()
  private unlisten = new Set<() => void>()
  constructor(private deps: {
    manager: ISessionManager
    workspaceRoot: (id: string) => string | null
    push: (snapshot: WorkspaceAttention) => void
    log?: (error: unknown) => void
  }) {}
  start(registry: PrWatchRegistry): void {
    this.stopRegistry?.()
    this.registry?.dropClient(CLIENT)
    this.registry = registry
    this.subscriptions.clear()
    this.stopRegistry = registry.onSessionState((sessionId, state) => {
      const session = this.deps.manager.getSessionSnapshot(sessionId)
      if (!session || session.isArchived || this.disposed) return
      const store = this.store(session.workspaceId)
      if (!store) return
      const next = reconcileGithubAttention(state, store.get(sessionId)?.reasons ?? [], Date.now(), this.activeAutoFix.get(sessionId))
      store.setGitHubState(sessionId, next.reasons, next.stale)
    })
    if (!this.interval) {
      this.interval = setInterval(() => { void this.sync() }, 60_000)
      this.interval.unref?.()
    }
    void this.sync()
  }
  snapshot(workspaceId: string): WorkspaceAttention {
    return this.store(workspaceId)?.snapshot() ?? { workspaceId, sessions: {}, revision: 0 }
  }
  setReasons(sessionId: string, source: AttentionSource, reasons: AttentionReason[]): void {
    const session = this.deps.manager.getSessionSnapshot(sessionId)
    if (session) this.store(session.workspaceId)?.setReasons(sessionId, source, reasons)
  }
  /** Add/update one prompt without replacing other pending prompts from the same source. */
  upsertReason(sessionId: string, reason: AttentionReason): void {
    const session = this.deps.manager.getSessionSnapshot(sessionId)
    if (!session) return
    const store = this.store(session.workspaceId)
    if (!store) return
    const sameSource = (store.get(sessionId)?.reasons ?? []).filter(r => r.source === reason.source)
    const previous = sameSource.find(r => r.id === reason.id)
    store.setReasons(sessionId, reason.source, [
      ...sameSource.filter(r => r.id !== reason.id),
      { ...reason, createdAt: previous?.createdAt ?? reason.createdAt },
    ])
  }
  /** Resolve one action without clearing unrelated permissions or authentication prompts. */
  resolve(sessionId: string, source: AttentionSource, reasonId?: string): void {
    const session = this.deps.manager.getSessionSnapshot(sessionId)
    if (!session) return
    const store = this.store(session.workspaceId)
    store?.setReasons(sessionId, source, reasonId ? (store.get(sessionId)?.reasons ?? []).filter(r => r.source === source && r.id !== reasonId) : [])
  }
  setAutoFixActive(sessionId: string, prId: string | null): void {
    if (prId) this.activeAutoFix.set(sessionId, prId)
    else this.activeAutoFix.delete(sessionId)
    const session = this.deps.manager.getSessionSnapshot(sessionId)
    if (session) this.setWorking(sessionId, !!session.isProcessing)
  }
  setWorking(sessionId: string, working: boolean): void {
    const session = this.deps.manager.getSessionSnapshot(sessionId)
    if (!session) return
    this.store(session.workspaceId)?.setWorking(sessionId, working)
    // Immediately re-evaluate whether PR feedback is currently handled by auto-fix.
    const state = this.registry?.cachedSessionState(sessionId)
    if (state) {
      const store = this.store(session.workspaceId)
      const next = reconcileGithubAttention(state, store?.get(sessionId)?.reasons ?? [], Date.now(), this.activeAutoFix.get(sessionId))
      store?.setGitHubState(sessionId, next.reasons, next.stale)
    }
  }
  sync(): Promise<void> {
    if (this.reconciling) return this.reconciling
    this.reconciling = this.reconcile().catch(error => this.deps.log?.(error)).finally(() => { this.reconciling = null })
    return this.reconciling
  }
  private async reconcile(): Promise<void> {
    const registry = this.registry
    if (!registry || this.disposed) return
    await this.deps.manager.waitForInit()
    if (this.disposed || this.registry !== registry) return
    const sessions = this.deps.manager.getSessions()
    const live = new Set(sessions.filter(s => !s.isArchived).map(s => s.id))
    for (const [id, sub] of this.subscriptions) {
      if (!live.has(id)) { registry.unsubscribe(sub.id); this.subscriptions.delete(id) }
    }
    for (const store of this.stores.values()) {
      for (const id of Object.keys(store.snapshot().sessions)) if (!live.has(id)) store.forget(id)
    }
    // Sequential local discovery, registry globally caps GraphQL concurrency at four.
    for (const session of sessions) {
      if (this.disposed || this.registry !== registry || session.isArchived) continue
      const store = this.store(session.workspaceId)
      const rootForShip = this.deps.workspaceRoot(session.workspaceId)
      const ship = (() => { try { return rootForShip ? findShipState(rootForShip, session.id) : null } catch (error) { this.deps.log?.(error); return undefined } })()
      store?.setWorking(session.id, !!session.isProcessing || ship?.status === 'running')
      const previousShip = store?.get(session.id)?.reasons.filter(r => r.source === 'ship') ?? []
      const shipReasons: AttentionReason[] = ship && (ship.status === 'waiting' || ship.status === 'blocked')
        ? (ship.reasons.length ? ship.reasons : [ship.phase === 'discussion' ? 'Plan ready for your decision' : ship.phase === 'human_review' ? 'Review the pull request before merging' : `Ship is waiting at ${ship.phase}`]).map((title, index) => ({
          id: `ship:${ship.id}:${ship.phase}:${index}`, source: 'ship', kind: 'ship', title,
          detail: `Ship · ${ship.phase}`, createdAt: previousShip[index]?.createdAt ?? Date.parse(ship.updatedAt),
          action: { type: 'session' },
        })) : []
      if (ship !== undefined) store?.setReasons(session.id, 'ship', shipReasons)
      const dir = this.deps.manager.getSessionWorkingDirectory(session.id) ?? session.workingDirectory
      const root = this.deps.workspaceRoot(session.workspaceId)
      const old = this.subscriptions.get(session.id)
      if (!dir || !root) {
        if (old) { registry.unsubscribe(old.id); this.subscriptions.delete(session.id) }
        continue
      }
      if (old?.dir === dir) {
        if (registry.cachedSessionState(session.id)?.kind === 'unavailable') void registry.nudge(session.id).catch(error => this.deps.log?.(error))
        continue
      }
      if (old) registry.unsubscribe(old.id)
      const subscription = await registry.subscribe({ clientId: CLIENT, sessionId: session.id, dir, workspaceRootPath: root,
        boundPrs: this.deps.manager.getSessionBoundPrs(session.id), monitors: this.deps.manager.getSessionPrMonitors(session.id) }).catch(error => { this.deps.log?.(error); return null })
      if (!subscription) continue
      if (this.disposed || this.registry !== registry) { registry.unsubscribe(subscription.subscriptionId); return }
      this.subscriptions.set(session.id, { id: subscription.subscriptionId, dir })
    }
  }
  private store(workspaceId: string): SessionAttentionStore | null {
    let store = this.stores.get(workspaceId)
    if (!store) {
      const root = this.deps.workspaceRoot(workspaceId)
      if (!root) return null
      store = new SessionAttentionStore(workspaceId, root)
      this.stores.set(workspaceId, store)
      this.unlisten.add(store.subscribe(this.deps.push))
    }
    return store
  }
  dispose(): void {
    this.disposed = true
    if (this.interval) clearInterval(this.interval)
    this.interval = null
    this.stopRegistry?.()
    this.registry?.dropClient(CLIENT)
    for (const stop of this.unlisten) stop()
    this.unlisten.clear()
    this.subscriptions.clear()
    this.activeAutoFix.clear()
  }
}
