import { createHmac, timingSafeEqual } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import { combineWebhookChanges, GITHUB_WEBHOOK_PATH, githubWebhookChange, webhookCoversRepo, type GithubWebhookChange, type GithubWebhookConfig, type GithubWebhookRetry } from './events'

const MAX_PENDING = 512
const MAX_SEEN = 4096
export const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024
const DELIVERY_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

interface PendingDelivery { id: string; change: GithubWebhookChange; retryAt: number }
interface Inbox { pending: PendingDelivery[]; seen: string[] }
type HttpHandler = (req: IncomingMessage, res: ServerResponse) => void

function validStoredChange(change: GithubWebhookChange): boolean {
  return !!change && !!change.repo && change.repo.host === 'github.com'
    && typeof change.repo.owner === 'string' && typeof change.repo.repo === 'string'
    && /^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i.test(`${change.repo.owner}/${change.repo.repo}`)
    && typeof change.all === 'boolean' && Array.isArray(change.numbers)
    && change.numbers.every(number => Number.isSafeInteger(number) && number > 0)
    && Array.isArray(change.shas) && change.shas.every(sha => typeof sha === 'string' && /^[a-f0-9]{40,64}$/i.test(sha))
    && [change.headRefs, change.baseRefs].every(refs => Array.isArray(refs)
      && refs.every(ref => typeof ref === 'string' && ref.length > 0 && ref.length <= 1024))
}

interface ReceiverOptions {
  config: GithubWebhookConfig
  statePath: string
  /** null = reconciled; otherwise persist only the remaining targets and their backoff. */
  onChange: (change: GithubWebhookChange) => Promise<GithubWebhookRetry | null>
  log?: (message: string) => void
}

/** A small bounded inbox, persisted before ACK and drained through the existing PR registry. */
export class GithubWebhookReceiver {
  private inbox: Inbox = { pending: [], seen: [] }
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerAt = Infinity
  private draining: Promise<void> | null = null
  private started = false
  private disposed = false
  readonly config: GithubWebhookConfig

  constructor(private readonly options: ReceiverOptions) {
    this.config = options.config
    if (!existsSync(options.statePath)) return
    if (statSync(options.statePath).size > MAX_WEBHOOK_BYTES) throw new Error('GitHub webhook inbox exceeds its size limit')
    const saved = JSON.parse(readFileSync(options.statePath, 'utf8')) as Inbox
    if (!Array.isArray(saved.pending) || !Array.isArray(saved.seen) || saved.pending.length > MAX_PENDING || saved.seen.length > MAX_SEEN
      || saved.seen.some(id => typeof id !== 'string' || !DELIVERY_ID.test(id))
      || saved.pending.some(item => !item || !DELIVERY_ID.test(item.id) || !Number.isFinite(item.retryAt)
        || !validStoredChange(item.change))) {
      throw new Error('Invalid GitHub webhook inbox; preserve the file and inspect it before enabling webhooks')
    }
    this.inbox = saved
  }

  start(): void {
    if (this.disposed) throw new Error('GitHub webhook receiver is stopped')
    this.started = true
    this.kick()
  }

  async stop(): Promise<void> {
    this.disposed = true
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.timerAt = Infinity
    await this.draining
  }

  accept(id: string, change: GithubWebhookChange): 'accepted' | 'duplicate' {
    if (this.disposed) throw new Error('GitHub webhook receiver is stopped')
    if (!DELIVERY_ID.test(id) || !webhookCoversRepo(change.repo, this.config.repositories)) throw new Error('Invalid webhook delivery')
    if (this.inbox.seen.includes(id) || this.inbox.pending.some(item => item.id === id)) return 'duplicate'
    if (this.inbox.pending.length >= MAX_PENDING) throw new Error('GitHub webhook inbox is full')
    this.save({ ...this.inbox, pending: [...this.inbox.pending, { id, change, retryAt: 0 }] })
    this.log(`accepted ${id} ${change.repo.owner}/${change.repo.repo}`)
    this.kick()
    return 'accepted'
  }

  private log(message: string): void { this.options.log?.(`[github-webhook] ${message}`) }

  private save(next: Inbox): void {
    const serialized = Buffer.from(JSON.stringify(next))
    if (serialized.length > MAX_WEBHOOK_BYTES) throw new Error('GitHub webhook inbox byte limit reached')
    const directory = dirname(this.options.statePath)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temp = `${this.options.statePath}.tmp`
    try {
      const fd = openSync(temp, 'w', 0o600)
      try { writeFileSync(fd, serialized); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temp, this.options.statePath)
      const dirFd = openSync(directory, 'r')
      try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
      this.inbox = next
    } finally { if (existsSync(temp)) unlinkSync(temp) }
  }

  private kick(): void {
    if (!this.started || this.disposed || this.draining || !this.inbox.pending.length) return
    const earliest = Math.min(...this.inbox.pending.map(item => item.retryAt))
    const at = Math.max(Date.now() + 250, earliest)
    // A steady event stream must not postpone an already-scheduled batch.
    if (this.timer && this.timerAt <= at) return
    if (this.timer) clearTimeout(this.timer)
    this.timerAt = at
    this.timer = setTimeout(() => {
      this.timer = null
      this.timerAt = Infinity
      this.draining = this.drain().catch(error => this.log(`processing failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => { this.draining = null; this.kick() })
    }, Math.max(0, at - Date.now()))
    this.timer.unref?.()
  }

  private async drain(): Promise<void> {
    const groups = new Map<string, PendingDelivery[]>()
    for (const item of this.inbox.pending) {
      if (item.retryAt > Date.now()) continue
      const key = `${item.change.repo.owner}/${item.change.repo.repo}`
      groups.set(key, [...(groups.get(key) ?? []), item])
    }
    for (const group of groups.values()) {
      if (this.disposed) return
      const ids = new Set(group.map(item => item.id))
      const change = combineWebhookChanges(group.map(item => item.change))
      let retry: GithubWebhookRetry | null = { retryAfterMs: 30_000, change }
      try {
        const result = webhookCoversRepo(change.repo, this.config.repositories) ? await this.options.onChange(change) : null
        if (result !== null && (!Number.isFinite(result.retryAfterMs) || result.retryAfterMs < 0
          || !Number.isFinite(Date.now() + result.retryAfterMs) || !validStoredChange(result.change)
          || result.change.repo.owner.toLowerCase() !== change.repo.owner.toLowerCase()
          || result.change.repo.repo.toLowerCase() !== change.repo.repo.toLowerCase())) {
          throw new Error('Invalid GitHub webhook retry')
        }
        retry = result
      }
      catch (error) { this.log(`refresh failed: ${error instanceof Error ? error.message : String(error)}`) }
      const retryAt = Date.now() + Math.max(1000, retry?.retryAfterMs ?? 0)
      // Keep the remaining union once; the other delivery IDs are covered by this durable entry.
      const retainedId = retry === null ? null : group[0]!.id
      const pending = this.inbox.pending.flatMap(item => !ids.has(item.id) ? [item]
        : retry !== null && item.id === retainedId ? [{ ...item, change: retry.change, retryAt }] : [])
      const completedIds = [...ids].filter(id => id !== retainedId)
      try {
        this.save({ pending, seen: [...this.inbox.seen, ...completedIds].slice(-MAX_SEEN) })
        this.log(`${retry === null ? 'processed' : 'deferred'} ${group.length} delivery(s) ${group[0]!.change.repo.owner}/${group[0]!.change.repo.repo}`)
      } catch (error) {
        // Keep accepted work in memory and on disk; avoid a busy retry loop on disk errors.
        for (const item of this.inbox.pending) if (ids.has(item.id)) item.retryAt = Date.now() + 30_000
        throw error
      }
    }
  }
}

function reply(res: ServerResponse, status: number, text: string): void {
  if (res.writableEnded || res.destroyed) return
  if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(text)
}

/** Intercept before the WebUI adapter, which otherwise buffers arbitrary-sized request bodies. */
export function createGithubWebhookHttpHandler(receiver: GithubWebhookReceiver, fallback?: HttpHandler): HttpHandler {
  let active = 0
  return (req, res) => {
    if (req.url?.split('?')[0] !== GITHUB_WEBHOOK_PATH) {
      if (fallback) fallback(req, res)
      else reply(res, 404, 'Not found')
      return
    }
    if (active >= 16) { reply(res, 503, 'Too many webhook requests'); req.resume(); return }
    active++
    void receive(req, res, receiver).catch(error => {
      console.warn(`[github-webhook] delivery failed: ${error instanceof Error ? error.message : String(error)}`)
      reply(res, 503, 'Webhook unavailable')
    }).finally(() => { active-- })
  }
}

async function receive(req: IncomingMessage, res: ServerResponse, receiver: GithubWebhookReceiver): Promise<void> {
  if (req.method !== 'POST') { reply(res, 405, 'POST required'); req.resume(); return }
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') { reply(res, 415, 'application/json required'); req.resume(); return }
  const signature = req.headers['x-hub-signature-256']
  const id = req.headers['x-github-delivery']
  const event = req.headers['x-github-event']
  if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signature)) { reply(res, 401, 'Invalid signature'); req.resume(); return }
  if (typeof id !== 'string' || !DELIVERY_ID.test(id) || typeof event !== 'string' || !/^[a-z_]{1,64}$/.test(event)) { reply(res, 400, 'Invalid delivery headers'); req.resume(); return }
  if (Number(req.headers['content-length'] ?? 0) > MAX_WEBHOOK_BYTES) { reply(res, 413, 'Payload too large'); req.resume(); return }
  const timeout = setTimeout(() => { reply(res, 408, 'Request timed out'); req.destroy() }, 10_000)
  timeout.unref?.()
  let body: Buffer
  try {
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of req) {
      bytes += chunk.length
      if (bytes > MAX_WEBHOOK_BYTES) { reply(res, 413, 'Payload too large'); return }
      chunks.push(Buffer.from(chunk))
    }
    body = Buffer.concat(chunks)
  } finally { clearTimeout(timeout) }
  const expected = createHmac('sha256', receiver.config.secret).update(body).digest()
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) { reply(res, 401, 'Invalid signature'); return }
  let payload: unknown
  try { payload = JSON.parse(body.toString('utf8')) } catch { reply(res, 400, 'Invalid JSON'); return }
  if (event === 'ping') { reply(res, 200, 'Pong'); return }
  let change: GithubWebhookChange | null
  try { change = githubWebhookChange(event, payload) } catch { reply(res, 400, 'Invalid webhook payload'); return }
  if (!change) { reply(res, 202, 'Ignored event'); return }
  if (!webhookCoversRepo(change.repo, receiver.config.repositories)) { reply(res, 403, 'Repository not allowed'); return }
  const result = receiver.accept(id.toLowerCase(), change)
  reply(res, result === 'duplicate' ? 200 : 202, result)
}
