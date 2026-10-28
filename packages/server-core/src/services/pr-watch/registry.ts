/**
 * PR watcher registry. A session tracks its branch's PR plus any PRs pinned to it
 * (pr_bind), and the chat-header chip shows them in a carousel. Each distinct target — a checkout's
 * branch, or a pinned `repo#number` — is one ref-counted {@link Watcher}, shared by every
 * subscription on it (several panels/windows, several sessions). A watcher polls on the adaptive
 * schedule, refreshes at once on triggers, and keeps the last good {@link PrWatchState}.
 *
 * What a client receives is the per-session AGGREGATE ({@link PrWatchSessionState}): the branch PR
 * first, then the bound PRs by `addedAt`, deduped by `host/owner/repo#number` so binding your own
 * branch's PR never doubles it. Availability is per-entry: a bound PR still shows while the folder
 * isn't a git repo.
 *
 * Gating still happens before any GitHub call for the BRANCH target (not a repo / detached HEAD /
 * non-GitHub remote never creates a branch watcher). Bound targets are resolved by number.
 */

import type {
  BoundPr,
  PrAutoMergeState,
  PrDetails,
  PrEntry,
  PrMergeMethod,
  PrMonitorState,
  PrQuickOperationRequest,
  PrQuickOperationResult,
  PrSummary,
  PrWatchSessionState,
  PrWatchState,
} from '@craft-agent/shared/protocol'
import {
  DETAILS_QUERY,
  DISABLE_AUTO_MERGE_MUTATION,
  ENABLE_AUTO_MERGE_MUTATION,
  PR_BY_NUMBER_QUERY,
  REVIEW_SIGNATURE_QUERY,
  SUMMARY_QUERY,
  type GqlAutoMergeMutationResponse,
  type GqlReviewSignatureResponse,
  type GqlByNumberResponse,
  type GqlDetailsResponse,
  type GqlPullRequestSummary,
  type GqlSummaryResponse,
} from './github-queries'
import { canFixLocally, prEntryId } from '@craft-agent/shared/pr-watch'
import { GitHubRequestError } from './github-client'
import { localStatus as defaultLocalStatus, resolveRepo as defaultResolveRepo, watchRefs as defaultWatchRefs, type LocalStatus, type RepoInfo } from './local-git'
import {
  allowedMergeMethods,
  autoMergeBlockMessage,
  mapAutoMergeBlock,
  mapDetails,
  mapMergeMethod,
  mapReviewSignature,
  mapSummary,
  pickMergeMethod,
  pickPullRequest,
} from './map-github'
import type { RepoCoordinates } from './remote-url'
import { nextPollDelay, POLL } from './schedule'
import { runGitResult } from '../git'
import { runPrQuickOperation, rerunFailedJobs } from './quick-actions'
import { TokenChain, type TokenCandidate } from './token-chain'
import { associatePr, savedPrSummary, type PrAssociation, type PrAssociationStore } from './association-store'

/** Details are cached this long, so a card re-asking every 15 s costs at most one query. */
const DETAILS_TTL_MS = 10_000
/** Even an unchanged aggregate is re-pushed this often, so the card's "Updated Xs ago" stays honest. */
const MAX_SILENT_MS = 60_000
/** No local checkout behind a bound PR, so it has no ahead/dirty state. */
const NO_LOCAL: LocalStatus = { localAhead: 0, localDirty: false }

export interface PrWatchDeps {
  associations?: PrAssociationStore
  /** GitHub GraphQL call; throws GitHubAuthError / GitHubRequestError */
  graphql<T>(host: string, token: string, query: string, variables: Record<string, unknown>): Promise<T>
  /** Credentials to try for a host, in order */
  candidates(host: string, workspaceRootPath: string): Promise<TokenCandidate[]>
  /** Delivers a session's aggregate to one client */
  push(clientId: string, sessionId: string, state: PrWatchSessionState): void
  resolveRepo?: (dir: string) => Promise<RepoInfo | null>
  localStatus?: (dir: string, prHeadOid: string | null) => Promise<LocalStatus>
  watchRefs?: (repo: RepoInfo, onChange: () => void) => () => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  log?: (message: string) => void
}

/** How a watcher resolves its PR: from a checkout's branch, or a pinned number. */
type WatcherTarget =
  | { kind: 'branch'; repo: WatchableRepo }
  | { kind: 'number'; coords: RepoCoordinates; number: number }

interface Subscription {
  foreground: boolean
  id: string
  clientId: string
  sessionId: string
  dir: string
  workspaceRootPath: string
  /** The branch watcher key, or null while the folder can't have a branch PR */
  branchKey: string | null
  /** Gated branch state when branchKey is null (not-git / none / not-github / error / loading) */
  branchState: PrWatchState
  /** Bound PR watcher keys, in carousel order (the session's boundPrs by addedAt) */
  boundKeys: string[]
}

interface Watcher {
  key: string
  target: WatcherTarget
  workspaceRootPath: string
  subscriptions: Set<string>
  state: PrWatchState
  /** The repository, number and node id of the PR the state describes */
  pr: { coords: RepoCoordinates; number: number; headOid: string } | null
  consecutiveErrors: number
  lastFetchAt?: number
  rateLimit?: { remaining: number; resetAt: number }
  retryAfterUntil?: number
  nextPollAt?: number
  timer: unknown
  inFlight: Promise<void> | null
  stopRefWatch: () => void
  details: { at: number; value: PrDetails | null } | null
}

type WatchableRepo = RepoInfo & { repo: RepoCoordinates; branch: string; remoteBranch: string }

/** A skipped automatic read is not a GitHub failure and must retain its cached state. */
class PollingPaused extends Error {}

function isWatchable(repo: RepoInfo): repo is WatchableRepo {
  return !!repo.branch && !!repo.remoteBranch && !!repo.repo
}

function coordsKey(coords: RepoCoordinates): string {
  return `${coords.host}/${coords.owner}/${coords.repo}`
}

/** Stable carousel id for a PR; also the dedup key across branch/bound entries (case-insensitive). */
function entryId(coords: RepoCoordinates, number: number): string {
  return prEntryId({ ...coords, number })
}

export function branchKeyOf(repo: WatchableRepo): string {
  return `branch|${repo.root}|${coordsKey(repo.repo)}@${repo.remoteBranch}`
}

export function numberKeyOf(workspaceRootPath: string, coords: RepoCoordinates, number: number): string {
  return `number|${workspaceRootPath}|${entryId(coords, number)}`
}

function associationMatches(target: WatcherTarget, saved: PrAssociation): boolean {
  const sameRepo = (coords: RepoCoordinates) => coordsKey(coords).toLowerCase() === coordsKey(saved.coords).toLowerCase()
  if (target.kind === 'number') return saved.number === target.number && sameRepo(target.coords)
  return saved.headRef === target.repo.remoteBranch && (sameRepo(target.repo.repo)
    || !!target.repo.upstreamRepo && sameRepo(target.repo.upstreamRepo))
}

/** Equal for the UI: everything but `fetchedAt`. */
function sameState(a: PrWatchState, b: PrWatchState): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'unavailable' && b.kind === 'unavailable') return a.reason === b.reason
  if (a.kind === 'pr' && b.kind === 'pr') return stripSummary(a.summary) === stripSummary(b.summary)
  return true
}

function stripSummary({ fetchedAt: _fetchedAt, ...rest }: PrSummary): string {
  return JSON.stringify(rest)
}

/** Equal aggregates: same kind/reason and, for `ready`, the same entries (ignoring fetchedAt). */
function sameSessionState(a: PrWatchSessionState, b: PrWatchSessionState): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'unavailable' && b.kind === 'unavailable') return a.reason === b.reason
  if (a.kind === 'ready' && b.kind === 'ready') {
    if (a.incomplete !== b.incomplete || a.prs.length !== b.prs.length) return false
    return a.prs.every((entry, i) => {
      const other = b.prs[i]!
      return entry.id === other.id && entry.origin === other.origin
        && entry.autoFix === other.autoFix && entry.autoFixLastRunAt === other.autoFixLastRunAt
        && stripSummary(entry.summary) === stripSummary(other.summary)
    })
  }
  return true
}

export class PrWatchRegistry {
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly watchers = new Map<string, Watcher>()
  /** Last aggregate delivered per `clientId|sessionId`, for change + MAX_SILENT dedup. */
  private readonly lastPushed = new Map<string, { state: PrWatchSessionState; at: number }>()
  /** Each live session's per-PR monitor state (auto-fix), stamped onto its entries for the UI. */
  private readonly sessionMonitors = new Map<string, Record<string, PrMonitorState>>()
  private readonly chain: TokenChain
  private readonly hostBudgets = new Map<string, { remaining: number; resetAt: number }>()
  private nextId = 1
  private readonly stateListeners = new Set<(sessionId: string, state: PrWatchSessionState) => void>()
  private activeRequests = 0
  private readonly waitingRequests: Array<() => void> = []
  private disposed = false

  /** Server observers do not depend on any renderer subscription. */
  onSessionState(listener: (sessionId: string, state: PrWatchSessionState) => void): () => void {
    this.stateListeners.add(listener)
    return () => { this.stateListeners.delete(listener) }
  }

  /** Bound concurrent GitHub requests across every session, including closed windows. */
  private async limited<T>(request: () => Promise<T>): Promise<T> {
    if (this.activeRequests >= 4) await new Promise<void>(resolve => this.waitingRequests.push(resolve))
    else this.activeRequests++
    if (this.disposed) throw new Error('PR registry disposed')
    try { return await request() }
    finally {
      const resume = this.waitingRequests.shift()
      if (resume) resume()
      else this.activeRequests--
    }
  }

  private readonly resolveRepo: NonNullable<PrWatchDeps['resolveRepo']>
  private readonly localStatus: NonNullable<PrWatchDeps['localStatus']>
  private readonly watchRefs: NonNullable<PrWatchDeps['watchRefs']>
  private readonly now: () => number
  private readonly setTimer: NonNullable<PrWatchDeps['setTimer']>
  private readonly clearTimer: NonNullable<PrWatchDeps['clearTimer']>
  private readonly log: (message: string) => void

  constructor(private readonly deps: PrWatchDeps) {
    this.resolveRepo = deps.resolveRepo ?? defaultResolveRepo
    this.localStatus = deps.localStatus ?? defaultLocalStatus
    this.watchRefs = deps.watchRefs ?? defaultWatchRefs
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.log = deps.log ?? (() => {})
    this.chain = new TokenChain(this.now)
  }

  /** Starts watching a session (branch PR + its bound PRs) for one client. Returns the aggregate. */
  async subscribe(input: {
    clientId: string
    sessionId: string
    dir: string
    workspaceRootPath: string
    boundPrs?: BoundPr[]
    monitors?: Record<string, PrMonitorState>
    foreground?: boolean
  }): Promise<{ subscriptionId: string; state: PrWatchSessionState }> {
    if (this.disposed) throw new Error('PR registry disposed')
    const subscription: Subscription = {
      id: `prw-${this.nextId++}`,
      foreground: input.foreground ?? false,
      clientId: input.clientId,
      sessionId: input.sessionId,
      dir: input.dir,
      workspaceRootPath: input.workspaceRootPath,
      branchKey: null,
      branchState: { kind: 'loading' },
      boundKeys: [],
    }
    this.subscriptions.set(subscription.id, subscription)
    if (input.monitors) this.sessionMonitors.set(input.sessionId, input.monitors)
    this.attachBound(subscription, input.boundPrs ?? [])
    await this.attachBranch(subscription)
    return { subscriptionId: subscription.id, state: this.aggregate(subscription) }
  }

  unsubscribe(subscriptionId: string): void {
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription) return
    this.subscriptions.delete(subscriptionId)
    if (subscription.branchKey) this.releaseWatcher(subscription.branchKey, subscription.id)
    for (const key of subscription.boundKeys) this.releaseWatcher(key, subscription.id)
    const remaining = this.subsForSession(subscription.sessionId)
    if (!remaining.some(s => s.clientId === subscription.clientId)) {
      this.lastPushed.delete(`${subscription.clientId}|${subscription.sessionId}`)
    }
    if (!remaining.length) this.sessionMonitors.delete(subscription.sessionId)
  }

  /** A client went away: drop all of its subscriptions. */
  dropClient(clientId: string): void {
    for (const subscription of [...this.subscriptions.values()]) {
      if (subscription.clientId === clientId) this.unsubscribe(subscription.id)
    }
  }

  /**
   * Something may have changed for a session (agent turn ended, Refresh): re-resolve the branch
   * (switches, `git init`, a new remote) and refetch every target, then push.
   */
  async nudge(sessionId: string, clientId?: string, automatic = false): Promise<void> {
    const subs = this.subsForSession(sessionId).filter(s => !clientId || s.clientId === clientId)
    const refreshed = new Set<string>()
    for (const subscription of subs) {
      await this.attachBranch(subscription)
      for (const key of this.targetKeys(subscription)) {
        if (refreshed.has(key)) continue
        refreshed.add(key)
        const watcher = this.watchers.get(key)
        if (watcher) {
          const now = this.now()
          const coolingDown = (watcher.retryAfterUntil ?? 0) > now
            || (watcher.consecutiveErrors > 0 && (watcher.nextPollAt ?? 0) > now)
            || (watcher.rateLimit && watcher.rateLimit.remaining < POLL.rateLimitFloor && watcher.rateLimit.resetAt > now)
          if (!automatic || !coolingDown) await this.refresh(watcher, !automatic)
        }
      }
    }
    this.pushSession(sessionId)
  }

  /**
   * The session's current aggregate from already-fetched watcher state, or null when it has no live
   * subscription. Never triggers a fetch — used by cross-session pr_status (R3).
   */
  cachedSessionState(sessionId: string): PrWatchSessionState | null {
    const subs = this.subsForSession(sessionId)
    return subs.length ? this.aggregate(subs[0]!) : null
  }

  /** Replace a session's per-PR monitor state (the auto-fix toggle) and push, so the card reflects it. */
  setSessionMonitors(sessionId: string, monitors: Record<string, PrMonitorState>): void {
    if (!this.subsForSession(sessionId).length) return
    this.sessionMonitors.set(sessionId, monitors)
    this.pushSession(sessionId)
  }

  /** Replace a session's bound PRs (pr_bind / pr_unbind): reconcile live subscriptions and push. */
  setSessionBoundPrs(sessionId: string, boundPrs: BoundPr[]): void {
    const subs = this.subsForSession(sessionId)
    for (const subscription of subs) this.attachBound(subscription, boundPrs)
    this.pushSession(sessionId)
  }

  /**
   * Fetch a PR once by number without creating a subscription — used by pr_bind to verify before
   * persisting (R1). Throws a clear error on a missing PR or no usable credential.
   */
  async verifyPr(input: { coords: RepoCoordinates; number: number; workspaceRootPath: string }): Promise<PrSummary> {
    const node = await this.fetchByNumber(input)
    return mapSummary(node, NO_LOCAL, { fetchedAt: this.now(), via: node.__via })
  }

  /**
   * One-shot status for a session's PRs (pr_status, current session): resolve the branch PR and each
   * bound PR without creating a persistent subscription. Returns the same aggregate the chip shows.
   */
  async fetchOnce(input: {
    dir: string
    workspaceRootPath: string
    boundPrs: BoundPr[]
  }): Promise<PrWatchSessionState> {
    const entries: PrEntry[] = []
    const seen = new Set<string>()

    // Branch PR first (gated exactly like a live branch watcher)
    const repo = await this.resolveRepo(input.dir)
    let branchUnavailable: PrWatchSessionState | null = null
    if (!repo) branchUnavailable = { kind: 'unavailable', reason: 'not-git' }
    else if (!isWatchable(repo)) branchUnavailable = !repo.branch ? { kind: 'none' } : { kind: 'unavailable', reason: 'not-github' }
    else {
      const branch = await this.resolveBranchPr(repo, input.workspaceRootPath).catch(() => null)
      if (branch && branch !== 'no-token') {
        const id = entryId(branch.coords, branch.node.number)
        seen.add(id)
        const local = await this.localStatus(repo.root, branch.node.headRefOid)
        entries.push({ id, origin: 'branch', summary: mapSummary(branch.node, local, { fetchedAt: this.now(), via: branch.via }) })
      } else {
        branchUnavailable = branch === 'no-token' ? { kind: 'unavailable', reason: 'no-token' } : { kind: 'none' }
      }
    }

    // Bound PRs
    for (const bp of input.boundPrs) {
      const coords = { host: bp.host, owner: bp.owner, repo: bp.repo }
      const id = entryId(coords, bp.number)
      if (seen.has(id)) continue
      const node = await this.fetchByNumber({ coords, number: bp.number, workspaceRootPath: input.workspaceRootPath }).catch(() => null)
      if (!node) continue
      seen.add(id)
      entries.push({ id, origin: 'bound', summary: mapSummary(node, NO_LOCAL, { fetchedAt: this.now(), via: node.__via }) })
    }

    if (entries.length > 0) return { kind: 'ready', prs: entries }
    return branchUnavailable ?? { kind: 'none' }
  }

  /**
   * Enable/disable GitHub auto-merge for a PR (the card's switch, pr_set_auto_merge). Returns the new
   * state; throws GitHub's reason when it won't (checked up front from the PR, or its refusal).
   */
  async setAutoMerge(input: {
    coords: RepoCoordinates
    number: number
    workspaceRootPath: string
    enabled: boolean
    method?: PrMergeMethod
  }): Promise<PrAutoMergeState> {
    const { coords, number, workspaceRootPath, enabled } = input
    const node = await this.fetchByNumber({ coords, number, workspaceRootPath })
    const prId = node.id
    const label = `${coords.owner}/${coords.repo} #${number}`
    if (enabled) {
      const blocked = mapAutoMergeBlock(node)
      if (blocked) throw new Error(autoMergeBlockMessage(blocked, label))
      const method = pickMergeMethod(node.baseRepository, input.method)
      if (!method) {
        const allowed = node.baseRepository ? allowedMergeMethods(node.baseRepository) : []
        throw new Error(`${coords.owner}/${coords.repo} doesn't allow ${input.method ?? 'any'} merges${allowed.length ? ` (it allows ${allowed.join(', ')})` : ''}.`)
      }
      const response = await this.runWithCredential(coords, workspaceRootPath, token =>
        this.deps.graphql<GqlAutoMergeMutationResponse>(coords.host, token, ENABLE_AUTO_MERGE_MUTATION, { prId, method: method.toUpperCase() }))
      if (!response) throw new Error(`No GitHub credential could enable auto-merge on ${label}.`)
      const pr = response.result.enablePullRequestAutoMerge?.pullRequest
      if (!pr) throw new Error(`GitHub didn't turn on auto-merge for ${label}.`)
      return pr.autoMergeRequest ? { enabled: true, method: mapMergeMethod(pr.autoMergeRequest.mergeMethod) } : { enabled: true, method }
    }
    const response = await this.runWithCredential(coords, workspaceRootPath, token =>
      this.deps.graphql<GqlAutoMergeMutationResponse>(coords.host, token, DISABLE_AUTO_MERGE_MUTATION, { prId }))
    if (!response) throw new Error(`No GitHub credential could disable auto-merge on ${label}.`)
    return { enabled: false }
  }

  private readonly actionsInFlight = new Set<string>()

  async runAction(input: { coords: RepoCoordinates; number: number; workspaceRootPath: string; dir: string; request: PrQuickOperationRequest }): Promise<PrQuickOperationResult> {
    const { coords, number, workspaceRootPath, dir, request } = input
    const key = entryId(coords, number)
    if (this.actionsInFlight.has(key)) throw new Error('An action is already running for this PR.')
    this.actionsInFlight.add(key)
    try {
      const node = await this.fetchByNumber({ coords, number, workspaceRootPath })
      return await runPrQuickOperation(node, request, {
        localStatus: async () => {
          const status = await runGitResult(dir, ['status', '--porcelain=v1', '--untracked-files=normal'])
          if (!status.ok) throw new Error('Could not verify this worktree before merging.')
          return { ...await this.localStatus(dir, node.headRefOid), localDirty: status.stdout.length > 0 }
        },
        graphql: async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
          const response = await this.runWithCredential(coords, workspaceRootPath, token => this.deps.graphql<T>(coords.host, token, query, variables))
          if (!response) throw new Error('No GitHub credential could perform this action.')
          return response.result
        },
        rerunFailedJobs: async runId => {
          const response = await this.runWithCredential(coords, workspaceRootPath, token => rerunFailedJobs(coords, token, runId))
          if (!response) throw new Error('No GitHub credential could restart this workflow.')
        },
      })
    } finally { this.actionsInFlight.delete(key) }
  }

  /**
   * The PR's review feedback as tokens (see `mapReviewSignature`), for auto-fix. Null when no
   * credential can see the PR or it no longer exists; network errors throw.
   */
  async fetchReviewSignature(input: { coords: RepoCoordinates; number: number; workspaceRootPath: string }): Promise<string[] | null> {
    const { coords, number, workspaceRootPath } = input
    if (!this.canPoll(coords.host, false)) return null
    const response = await this.runWithCredential(coords, workspaceRootPath, token =>
      this.deps.graphql<GqlReviewSignatureResponse>(coords.host, token, REVIEW_SIGNATURE_QUERY, { owner: coords.owner, name: coords.repo, number }))
    const pr = response?.result.repository?.pullRequest
    return pr ? mapReviewSignature(pr, response!.result.viewer?.login ?? null) : null
  }

  /** The card's details for one carousel entry (cached briefly); also refreshes a branch PR's local state. */
  async getDetails(sessionId: string, prId: string, clientId: string): Promise<PrDetails | null> {
    const watcher = this.watcherForEntry(sessionId, prId, clientId)
    if (!watcher?.pr) return null
    if (!this.canPoll(watcher.pr.coords.host, true)) return watcher.details?.value ?? null
    if (watcher.details && this.now() - watcher.details.at < DETAILS_TTL_MS) return watcher.details.value

    const { coords, number, headOid } = watcher.pr
    const [response, local] = await Promise.all([
      this.withToken(watcher, coords, token => this.deps.graphql<GqlDetailsResponse>(coords.host, token, DETAILS_QUERY, { owner: coords.owner, name: coords.repo, number })).catch(() => null),
      watcher.target.kind === 'branch' ? this.localStatus(watcher.target.repo.root, headOid) : Promise.resolve(null),
    ])
    if (local) this.updateLocal(watcher, local)
    const raw = response?.result.repository?.pullRequest
    const value = raw ? mapDetails(raw) : null
    watcher.details = { at: this.now(), value }
    return value
  }

  /** Stops every watcher (server shutdown). */
  dispose(): void {
    for (const watcher of this.watchers.values()) this.stopWatcher(watcher)
    this.disposed = true
    this.stateListeners.clear()
    for (const resume of this.waitingRequests.splice(0)) resume()
    this.watchers.clear()
    this.subscriptions.clear()
    this.lastPushed.clear()
    this.sessionMonitors.clear()
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private subsForSession(sessionId: string): Subscription[] {
    return [...this.subscriptions.values()].filter(s => s.sessionId === sessionId)
  }

  private targetKeys(subscription: Subscription): string[] {
    return subscription.branchKey ? [subscription.branchKey, ...subscription.boundKeys] : subscription.boundKeys
  }

  /** The watcher backing a carousel entry for a session, if any (prefers the client's own subs). */
  private watcherForEntry(sessionId: string, prId: string, clientId: string): Watcher | undefined {
    const subs = this.subsForSession(sessionId)
    const ordered = [...subs.filter(s => s.clientId === clientId), ...subs.filter(s => s.clientId !== clientId)]
    for (const subscription of ordered) {
      for (const key of this.targetKeys(subscription)) {
        const watcher = this.watchers.get(key)
        if (watcher?.pr && entryId(watcher.pr.coords, watcher.pr.number) === prId) return watcher
      }
    }
    return undefined
  }

  // ── aggregate + push ─────────────────────────────────────────────────────

  /** Build the session's aggregate from a representative subscription (all its subs share targets). */
  private aggregate(subscription: Subscription): PrWatchSessionState {
    const entries: PrEntry[] = []
    const seen = new Set<string>()

    const branchWatcher = subscription.branchKey ? this.watchers.get(subscription.branchKey) : null
    const branchState = branchWatcher?.state ?? subscription.branchState
    if (branchWatcher?.state.kind === 'pr' && branchWatcher.pr) {
      const id = entryId(branchWatcher.pr.coords, branchWatcher.pr.number)
      seen.add(id)
      entries.push(this.withMonitor(subscription.sessionId, { id, origin: 'branch', summary: branchWatcher.state.summary }))
    }

    for (const key of subscription.boundKeys) {
      const watcher = this.watchers.get(key)
      if (watcher?.state.kind !== 'pr' || !watcher.pr) continue
      const id = entryId(watcher.pr.coords, watcher.pr.number)
      if (seen.has(id)) continue // the branch's own PR was also bound — don't double it
      seen.add(id)
      entries.push(this.withMonitor(subscription.sessionId, { id, origin: 'bound', summary: watcher.state.summary }))
    }

    if (entries.length > 0) {
      const states = [branchState, ...subscription.boundKeys.map(key => this.watchers.get(key)?.state)]
      const incomplete = states.some(state => !state || state.kind === 'loading' || state.kind === 'unavailable')
      return { kind: 'ready', prs: entries, ...(incomplete ? { incomplete: true } : {}) }
    }

    // Nothing resolved: mirror the branch/bound state so the chip hides exactly as before.
    const boundStates = subscription.boundKeys.map(key => this.watchers.get(key)?.state.kind)
    if (branchState.kind === 'loading' || boundStates.includes('loading')) return { kind: 'loading' }
    if (branchState.kind === 'unavailable') return { kind: 'unavailable', reason: branchState.reason }
    return { kind: 'none' }
  }

  /**
   * Stamp a session's auto-fix state onto one entry: only when on (so pushes stay small) and only on
   * the branch's own PR, the one auto-fix acts on (`canFixLocally`).
   */
  private withMonitor(sessionId: string, entry: PrEntry): PrEntry {
    const monitor = this.sessionMonitors.get(sessionId)?.[entry.id]
    if (!monitor?.autoFix || !canFixLocally(entry.origin)) return entry
    return { ...entry, autoFix: true, ...(monitor.lastFixAt ? { autoFixLastRunAt: monitor.lastFixAt } : {}) }
  }

  /** Recompute and deliver a session's aggregate to each of its clients (change + MAX_SILENT gated). */
  private pushSession(sessionId: string): void {
    const subs = this.subsForSession(sessionId)
    if (!subs.length) return
    const state = this.aggregate(subs[0]!)
    const now = this.now()
    for (const listener of this.stateListeners) {
      try { listener(sessionId, state) } catch (error) { this.log(`[pr-watch] observer failed: ${String(error)}`) }
    }
    for (const clientId of new Set(subs.map(s => s.clientId))) {
      const key = `${clientId}|${sessionId}`
      const previous = this.lastPushed.get(key)
      if (previous && sameSessionState(previous.state, state) && now - previous.at < MAX_SILENT_MS) continue
      this.lastPushed.set(key, { state, at: now })
      this.deps.push(clientId, sessionId, state)
    }
  }

  // ── branch target ─────────────────────────────────────────────────────────

  /** Resolve the subscription's folder and (re)bind it to the right branch watcher, or a gated state. */
  private async attachBranch(subscription: Subscription): Promise<void> {
    const repo = await this.resolveRepo(subscription.dir)
    if (!this.subscriptions.has(subscription.id)) return

    if (!repo || !isWatchable(repo)) {
      if (subscription.branchKey) {
        this.releaseWatcher(subscription.branchKey, subscription.id)
        subscription.branchKey = null
      }
      subscription.branchState = !repo
        ? { kind: 'unavailable', reason: 'not-git' }
        : !repo.branch ? { kind: 'none' } : { kind: 'unavailable', reason: 'not-github' }
      return
    }

    const key = branchKeyOf(repo)
    if (subscription.branchKey === key) return
    if (subscription.branchKey) this.releaseWatcher(subscription.branchKey, subscription.id)
    subscription.branchKey = key
    subscription.branchState = { kind: 'loading' }
    this.refOrCreateWatcher(key, { kind: 'branch', repo }, subscription)
  }

  // ── bound targets ─────────────────────────────────────────────────────────

  /** Reconcile a subscription's bound watchers to `boundPrs` (create new, release removed). */
  private attachBound(subscription: Subscription, boundPrs: BoundPr[]): void {
    const keys: string[] = []
    for (const bp of boundPrs) {
      const coords: RepoCoordinates = { host: bp.host, owner: bp.owner, repo: bp.repo }
      const key = numberKeyOf(subscription.workspaceRootPath, coords, bp.number)
      if (keys.includes(key)) continue
      keys.push(key)
      if (!subscription.boundKeys.includes(key)) {
        this.refOrCreateWatcher(key, { kind: 'number', coords, number: bp.number }, subscription)
      }
    }
    for (const key of subscription.boundKeys) {
      if (!keys.includes(key)) this.releaseWatcher(key, subscription.id)
    }
    subscription.boundKeys = keys
  }

  // ── watcher lifecycle ───────────────────────────────────────────────────

  private refOrCreateWatcher(key: string, target: WatcherTarget, subscription: Subscription): void {
    let watcher = this.watchers.get(key)
    if (!watcher) {
      watcher = this.createWatcher(key, target, subscription.workspaceRootPath)
      watcher.subscriptions.add(subscription.id)
      void this.refresh(watcher)
    } else {
      watcher.subscriptions.add(subscription.id)
      if (subscription.foreground && !watcher.inFlight) this.schedule(watcher)
    }
  }

  private releaseWatcher(key: string, subscriptionId: string): void {
    const watcher = this.watchers.get(key)
    if (!watcher) return
    watcher.subscriptions.delete(subscriptionId)
    if (watcher.subscriptions.size === 0) {
      this.stopWatcher(watcher)
      this.watchers.delete(key)
    } else if (!watcher.inFlight) {
      this.schedule(watcher)
    }
  }

  private createWatcher(key: string, target: WatcherTarget, workspaceRootPath: string): Watcher {
    const watcher: Watcher = {
      key,
      target,
      workspaceRootPath,
      subscriptions: new Set(),
      state: { kind: 'loading' },
      pr: null,
      consecutiveErrors: 0,
      timer: null,
      inFlight: null,
      stopRefWatch: () => {},
      details: null,
    }
    try {
      const saved = this.deps.associations?.load(workspaceRootPath, key)
      if (saved && associationMatches(target, saved)) {
        watcher.pr = { coords: saved.coords, number: saved.number, headOid: saved.headOid }
        watcher.state = { kind: 'pr', summary: savedPrSummary(saved) }
      }
    } catch (error) { this.log(`[pr-association] read failed: ${(error as Error).message}`) }
    // A commit, checkout or push moves a ref: re-resolve the branch and refetch (branch targets only).
    if (target.kind === 'branch') {
      watcher.stopRefWatch = this.watchRefs(target.repo, () => {
        const subs = [...watcher.subscriptions].map(id => this.subscriptions.get(id)).filter((s): s is Subscription => !!s)
        void this.reattachBranch(subs)
      })
    }
    this.watchers.set(key, watcher)
    return watcher
  }

  private stopWatcher(watcher: Watcher): void {
    watcher.nextPollAt = undefined
    if (watcher.timer !== null) this.clearTimer(watcher.timer)
    watcher.timer = null
    watcher.stopRefWatch()
  }

  /** Re-resolve a set of branch subscriptions (ref changed); refetch each watcher once; push. */
  private async reattachBranch(subs: Subscription[]): Promise<void> {
    const refreshed = new Set<string>()
    const sessions = new Set<string>()
    for (const subscription of subs) {
      sessions.add(subscription.sessionId)
      await this.attachBranch(subscription)
      const key = subscription.branchKey
      if (key && !refreshed.has(key)) {
        refreshed.add(key)
        const watcher = this.watchers.get(key)
        if (watcher) await this.refresh(watcher)
      }
    }
    for (const sessionId of sessions) this.pushSession(sessionId)
  }

  // ── credentials ─────────────────────────────────────────────────────────

  private canPoll(host: string, foreground: boolean): boolean {
    const budget = this.hostBudgets.get(host)
    if (!budget || budget.resetAt <= this.now()) return true
    return budget.remaining >= (foreground ? POLL.rateLimitFloor : POLL.rateLimitSlow)
  }

  private canPollWatcher(watcher: Watcher): boolean {
    const host = this.watcherHost(watcher)
    const foreground = this.isForeground(watcher)
    if (!this.canPoll(host, foreground)) return false
    const budget = this.hostBudgets.get(host)
    return !budget || budget.resetAt <= this.now() || budget.remaining >= POLL.rateLimitSlow
      || watcher.lastFetchAt === undefined || this.now() - watcher.lastFetchAt >= POLL.rateLimitForeground
  }

  private observeBudget(host: string, result: unknown): void {
    if (!result || typeof result !== 'object' || !('rateLimit' in result)) return
    const limit = result.rateLimit as { remaining?: unknown; resetAt?: unknown } | null
    if (!limit || typeof limit.remaining !== 'number' || !Number.isFinite(limit.remaining)
      || limit.remaining < 0 || typeof limit.resetAt !== 'string') return
    const resetAt = Date.parse(limit.resetAt)
    if (!Number.isFinite(resetAt)) return
    const previous = this.hostBudgets.get(host)
    const active = previous && previous.resetAt > this.now() ? previous : undefined
    const remaining = Math.min(active?.remaining ?? Infinity, limit.remaining)
    this.hostBudgets.set(host, { remaining, resetAt: Math.max(active?.resetAt ?? resetAt, resetAt) })
    const band = (value: number) => value < POLL.rateLimitFloor ? 0 : value < POLL.rateLimitSlow ? 1 : 2
    if (band(previous?.remaining ?? Infinity) !== band(remaining)) {
      for (const watcher of this.watchers.values()) {
        if (this.watcherHost(watcher) === host && !watcher.inFlight) this.schedule(watcher)
      }
    }
  }

  private watcherHost(watcher: Watcher): string {
    return watcher.target.kind === 'branch' ? watcher.target.repo.repo.host : watcher.target.coords.host
  }

  private isForeground(watcher: Watcher): boolean {
    return [...watcher.subscriptions].some(id => this.subscriptions.get(id)?.foreground)
  }

  private runWithCredential<T>(coords: RepoCoordinates, workspaceRootPath: string, attempt: (token: string) => Promise<T>, poll?: { watcher: Watcher; force: boolean }): Promise<{ result: T; via: string } | null> {
    return this.limited(async () => {
      // Recheck after waiting for a request slot: another PR may have spent the shared budget.
      if (poll && !poll.force && !this.canPollWatcher(poll.watcher)) throw new PollingPaused()
      return this.chain.run(coordsKey(coords), await this.deps.candidates(coords.host, workspaceRootPath), async token => {
        const result = await attempt(token)
        this.observeBudget(coords.host, result)
        return result
      })
    })
  }

  private withToken<T>(watcher: Watcher, coords: RepoCoordinates, attempt: (token: string) => Promise<T>): Promise<{ result: T; via: string } | null> {
    return this.runWithCredential(coords, watcher.workspaceRootPath, attempt)
  }

  // ── fetching ──────────────────────────────────────────────────────────────

  /** One summary fetch; concurrent callers share it. */
  private refresh(watcher: Watcher, force = false): Promise<void> {
    if (watcher.inFlight) return watcher.inFlight
    if (watcher.timer !== null) {
      this.clearTimer(watcher.timer)
      watcher.timer = null
    }
    watcher.inFlight = this.fetchSummary(watcher, force).finally(() => {
      watcher.inFlight = null
      if (this.watchers.get(watcher.key) === watcher) this.schedule(watcher)
    })
    return watcher.inFlight
  }

  private async fetchSummary(watcher: Watcher, force: boolean): Promise<void> {
    try {
      const resolved = watcher.target.kind === 'branch'
        ? await this.resolveBranchPr(watcher.target.repo, watcher.workspaceRootPath, watcher, force)
        : await this.resolveNumberPr(watcher.target.coords, watcher.target.number, watcher.workspaceRootPath, watcher, force)

      watcher.consecutiveErrors = 0
      watcher.lastFetchAt = this.now()
      watcher.retryAfterUntil = undefined
      if (resolved === 'no-token') {
        if (watcher.state.kind === 'pr') {
          this.setState(watcher, { ...watcher.state, summary: { ...watcher.state.summary, attentionStale: true } })
          return
        }
        watcher.pr = null
        this.setState(watcher, { kind: 'unavailable', reason: 'no-token' })
        return
      }
      if (!resolved) {
        if (watcher.state.kind === 'pr') {
          this.setState(watcher, { kind: 'pr', summary: { ...watcher.state.summary, attentionStale: true } })
          return
        }
        watcher.pr = null
        this.setState(watcher, { kind: 'none' })
        return
      }
      const { node, coords, via } = resolved
      const previous = watcher.state.kind === 'pr' ? watcher.state.summary : undefined
      // GitHub can briefly return an older snapshot after a merge.
      if (previous?.state === 'merged' && previous.url === node.url && node.state !== 'MERGED') return
      const local = watcher.target.kind === 'branch' ? await this.localStatus(watcher.target.repo.root, node.headRefOid) : NO_LOCAL
      if (watcher.pr?.number !== node.number || watcher.pr.headOid !== node.headRefOid) watcher.details = null
      const summary = mapSummary(node, local, { fetchedAt: this.now(), via })
      watcher.pr = { coords, number: node.number, headOid: node.headRefOid }
      try { this.deps.associations?.save(watcher.workspaceRootPath, watcher.key, associatePr(coords, summary)) }
      catch (error) { this.log(`[pr-association] write failed: ${(error as Error).message}`) }
      this.setState(watcher, { kind: 'pr', summary })
    } catch (error) {
      if (error instanceof PollingPaused) return
      watcher.consecutiveErrors++
      if (error instanceof GitHubRequestError && error.retryAfterMs) watcher.retryAfterUntil = this.now() + error.retryAfterMs
      this.log(`[pr-watch] ${watcher.key}: ${(error as Error).message}`)
      // Keep the last good state (its fetchedAt ages in the card); a failing first fetch hides the chip
      if (watcher.state.kind === 'pr') this.setState(watcher, { ...watcher.state, summary: { ...watcher.state.summary, attentionStale: true } })
      if (watcher.state.kind === 'loading') this.setState(watcher, { kind: 'unavailable', reason: 'error' })
    }
  }

  /** Resolve the branch's PR (with the fork fallback). Returns `'no-token'` when no credential answered. */
  private async resolveBranchPr(
    repo: WatchableRepo,
    workspaceRootPath: string,
    watcher?: Watcher,
    force = false,
  ): Promise<{ node: GqlPullRequestSummary; coords: RepoCoordinates; via: string } | 'no-token' | null> {
    let previousPr: { node: GqlPullRequestSummary; coords: RepoCoordinates; via: string } | undefined
    // Like Conductor's hasPrNumber query: search the branch once, then read the known PR.
    if (watcher?.pr && !force) {
      const known = await this.resolveNumberPr(watcher.pr.coords, watcher.pr.number, workspaceRootPath, watcher, force)
      if (known && known !== 'no-token' && known.node.headRefName === repo.remoteBranch
        && pickPullRequest([known.node], repo.repo.owner)) {
        // A branch may have been reused while this backend was stopped.
        if (known.node.state === 'OPEN' || watcher.state.kind !== 'pr' || !watcher.state.summary.attentionStale) return known
        previousPr = known
      }
    }
    const query = async (coords: RepoCoordinates) => {
      const response = await this.runWithCredential(coords, workspaceRootPath, token =>
        this.deps.graphql<GqlSummaryResponse>(coords.host, token, SUMMARY_QUERY, { owner: coords.owner, name: coords.repo, branch: repo.remoteBranch }), watcher ? { watcher, force } : undefined)
      if (!response) return null
      if (watcher && response.result.rateLimit) watcher.rateLimit = { remaining: response.result.rateLimit.remaining, resetAt: Date.parse(response.result.rateLimit.resetAt) }
      const node = pickPullRequest(response.result.repository?.pullRequests.nodes ?? [], repo.repo.owner)
      return { node, via: response.via, coords }
    }

    let found = await query(repo.repo)
    // Fork workflow: the PR lives on the upstream repository, opened from our fork's branch
    if (found && !found.node && repo.upstreamRepo && repo.upstreamRepo.host === repo.repo.host) {
      found = (await query(repo.upstreamRepo)) ?? found
    }
    if (!found) return 'no-token'
    if (!found.node) return previousPr ?? null
    return { node: found.node, coords: found.coords, via: found.via }
  }

  /** Resolve a pinned PR by number. Returns `'no-token'` when no credential answered, null when absent. */
  private async resolveNumberPr(
    coords: RepoCoordinates,
    number: number,
    workspaceRootPath: string,
    watcher?: Watcher,
    force = false,
  ): Promise<{ node: GqlPullRequestSummary; coords: RepoCoordinates; via: string } | 'no-token' | null> {
    const response = await this.runWithCredential(coords, workspaceRootPath, token =>
      this.deps.graphql<GqlByNumberResponse>(coords.host, token, PR_BY_NUMBER_QUERY, { owner: coords.owner, name: coords.repo, number }), watcher ? { watcher, force } : undefined)
    if (!response) return 'no-token'
    if (watcher && response.result.rateLimit) watcher.rateLimit = { remaining: response.result.rateLimit.remaining, resetAt: Date.parse(response.result.rateLimit.resetAt) }
    const node = response.result.repository?.pullRequest
    if (!node) return null
    return { node, coords, via: response.via }
  }

  /** Fetch one PR by number for a standalone caller (verify / auto-merge / status). Throws on failure. */
  private async fetchByNumber(input: { coords: RepoCoordinates; number: number; workspaceRootPath: string }): Promise<GqlPullRequestSummary & { __via: string }> {
    const { coords, number, workspaceRootPath } = input
    const response = await this.runWithCredential(coords, workspaceRootPath, token =>
      this.deps.graphql<GqlByNumberResponse>(coords.host, token, PR_BY_NUMBER_QUERY, { owner: coords.owner, name: coords.repo, number }))
    if (!response) throw new Error(`No GitHub credential can access ${coords.owner}/${coords.repo} (it may not exist or be private to you).`)
    const node = response.result.repository?.pullRequest
    if (!node) throw new Error(`PR #${number} not found in ${coords.owner}/${coords.repo}.`)
    return { ...node, __via: response.via }
  }

  private updateLocal(watcher: Watcher, local: LocalStatus): void {
    if (watcher.state.kind !== 'pr') return
    const { summary } = watcher.state
    if (summary.localAhead === local.localAhead && summary.localDirty === local.localDirty && summary.headMatchesLocal === local.headMatchesLocal) return
    this.setState(watcher, { ...watcher.state, summary: { ...summary, ...local } })
  }

  /** Update a watcher's state and push the aggregate to every session subscribed to it. */
  private setState(watcher: Watcher, state: PrWatchState): void {
    const changed = !sameState(watcher.state, state)
    watcher.state = state
    const sessions = new Set<string>()
    for (const id of watcher.subscriptions) {
      const subscription = this.subscriptions.get(id)
      if (subscription) sessions.add(subscription.sessionId)
    }
    for (const sessionId of sessions) this.pushSession(sessionId)
  }

  private schedule(watcher: Watcher): void {
    watcher.nextPollAt = undefined
    if (watcher.timer !== null) {
      this.clearTimer(watcher.timer)
      watcher.timer = null
    }
    if (watcher.subscriptions.size === 0) return
    const now = this.now()
    // A saved terminal state still needs one successful refresh after a cold start.
    const state = watcher.state.kind === 'pr' && watcher.state.summary.attentionStale
      ? { kind: 'loading' } as const : watcher.state
    let delay = nextPollDelay({
      state,
      foreground: this.isForeground(watcher),
      now,
      consecutiveErrors: watcher.consecutiveErrors,
      rateLimit: this.hostBudgets.get(this.watcherHost(watcher)) ?? watcher.rateLimit,
    })
    if (delay === null) return
    if (watcher.retryAfterUntil && watcher.retryAfterUntil > now) delay = Math.max(delay, watcher.retryAfterUntil - now)
    watcher.nextPollAt = now + delay
    watcher.timer = this.setTimer(() => {
      watcher.timer = null
      watcher.nextPollAt = undefined
      void this.refresh(watcher)
    }, delay)
  }
}
