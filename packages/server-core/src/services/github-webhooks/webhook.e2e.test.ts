import { afterEach, describe, expect, it } from 'bun:test'
import { createHmac, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request, type ClientRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS, type PrWatchSessionState } from '@craft-agent/shared/protocol'
import { WsRpcServer } from '../../transport/server'
import { WsRpcClient } from '../../transport/client'
import { pushTyped } from '../../transport/push'
import { PrWatchRegistry } from '../pr-watch/registry'
import type { GqlPullRequestSummary } from '../pr-watch/github-queries'
import type { LocalStatus, RepoInfo } from '../pr-watch/local-git'
import { GithubWebhookReceiver, createGithubWebhookHttpHandler, MAX_WEBHOOK_BYTES } from './receiver'
import { GITHUB_WEBHOOK_PATH, type GithubWebhookConfig } from './events'

const SECRET = 'e2e-only-github-webhook-secret-32-characters'
const TOKEN = 'e2e-only-craft-websocket-token'
const SHA = 'a'.repeat(40)
const teardown: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of teardown.splice(0).reverse()) await close()
})

function pr(owner = 'acme'): GqlPullRequestSummary {
  return {
    id: `PR_${owner}_7`, number: 7, title: 'Webhook test', url: `https://github.com/${owner}/app/pull/7`,
    state: 'OPEN', isDraft: false, headRefName: 'feature', baseRefName: 'main', headRefOid: SHA,
    headRepositoryOwner: { login: owner }, reviewDecision: null, mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN', autoMergeRequest: null, viewerCanEnableAutoMerge: true,
    baseRepository: { autoMergeAllowed: true, viewerDefaultMergeMethod: 'SQUASH', mergeCommitAllowed: true,
      squashMergeAllowed: true, rebaseMergeAllowed: true },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    reviewThreads: { nodes: [] },
  }
}

async function until(predicate: () => boolean, message = 'Timed out waiting for E2E state'): Promise<void> {
  const deadline = Date.now() + 4000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await Bun.sleep(10)
  }
}

function summary(state: PrWatchSessionState | undefined) {
  return state?.kind === 'ready' ? state.prs[0]?.summary : undefined
}

function payload(repository = 'acme/app') {
  return { action: 'synchronize', repository: { full_name: repository },
    pull_request: { number: 7, head: { ref: 'feature', sha: SHA }, base: { ref: 'main' } } }
}

/** Real HTTP/WebSocket transport and registry; only upstream GitHub responses and local git are fake. */
async function harness(options: { scopes?: string[]; start?: boolean; noPr?: boolean; fallback?: boolean;
  localForHead?: (head: string | null) => LocalStatus } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'craft-webhook-e2e-'))
  teardown.push(() => rmSync(dir, { recursive: true, force: true }))
  const statePath = join(dir, 'inbox.json')
  const config: GithubWebhookConfig = { secret: SECRET, repositories: options.scopes ?? ['acme/app'] }
  const nodes: Record<string, GqlPullRequestSummary> = { acme: pr(), unrelated: pr('unrelated') }
  const historicalPrs = new Map<string, GqlPullRequestSummary>()
  const calls: Array<{ query: string; owner: string; number?: number }> = []
  const changes: string[] = []
  const pushed: Array<{ session: string; state: PrWatchSessionState }> = []
  let missingPr = options.noPr ?? false
  let release: (() => void) | null = null
  let nextGate: Promise<void> | null = null
  let detailTitle = 'Before review'
  let server: WsRpcServer
  const registry = new PrWatchRegistry({
    graphql: async <T,>(_host: string, _token: string, query: string, variables: Record<string, unknown>) => {
      const owner = variables.owner as string
      calls.push({ query, owner, number: variables.number as number | undefined })
      const current = query.includes('PrByNumber')
        ? historicalPrs.get(`${owner}/${variables.number}`) ?? nodes[owner]
        : nodes[owner]
      const node = missingPr || query.includes('PrByNumber') && current?.number !== variables.number
        ? null : structuredClone(current ?? null)
      const gate = nextGate
      nextGate = null
      if (gate) await gate
      if (query.includes('PrDetails')) {
        return { repository: { pullRequest: { additions: 1, deletions: 0, changedFiles: 1,
          commits: { nodes: [{ commit: { oid: SHA, messageHeadline: detailTitle, committedDate: '2026-10-01T00:00:00Z',
            author: { name: 'Test', user: null }, statusCheckRollup: null } }] }, latestOpinionatedReviews: { nodes: [] },
          reviewRequests: { nodes: [] } } } } as T
      }
      const repository = query.includes('PrByNumber')
        ? { pullRequest: node }
        : { pullRequests: { nodes: node ? [node] : [] } }
      return { repository, rateLimit: { remaining: 4000, resetAt: '2035-01-01T00:00:00Z' } } as T
    },
    candidates: async () => [{ id: 'e2e', label: 'E2E fake GitHub', getToken: async () => 'not-a-real-token' }],
    resolveRepo: async (path): Promise<RepoInfo> => {
      const owner = path.includes('unrelated') ? 'unrelated' : 'acme'
      return { root: path, gitDir: `${path}/.git`, commonDir: `${path}/.git`, branch: 'feature',
        pushRemote: 'origin', remoteBranch: 'feature', repo: { host: 'github.com', owner, repo: 'app' }, upstreamRepo: null }
    },
    localStatus: async (_dir, head) => options.localForHead?.(head) ?? ({ localAhead: 0, localDirty: false }),
    watchRefs: () => () => {},
    push: (clientId, sessionId, state) => pushTyped(server, RPC_CHANNELS.prWatch.CHANGED, { to: 'client', clientId }, sessionId, state),
  })
  registry.configureWebhookRepositories(config.repositories)
  teardown.push(() => registry.dispose())
  function makeReceiver() {
    return new GithubWebhookReceiver({ config, statePath, onChange: async change => {
      changes.push(`${change.repo.owner}/${change.repo.repo}`)
      return registry.invalidateFromWebhook(change)
    } })
  }
  let receiver = makeReceiver()
  teardown.push(async () => { await receiver.stop() })
  const fallback = options.fallback ? ((_req: any, res: any) => { res.writeHead(200); res.end('existing-webui') }) : undefined
  let httpHandler = createGithubWebhookHttpHandler(receiver, fallback)
  let httpRequests = 0
  let activeHttpRequests = 0
  server = new WsRpcServer({ host: '127.0.0.1', port: 0, serverId: 'github-webhook-e2e', requireAuth: true,
    validateToken: async token => token === TOKEN,
    httpHandler: (req, res) => {
      httpRequests++
      activeHttpRequests++
      res.once('close', () => { activeHttpRequests-- })
      httpHandler(req, res)
    },
  })
  server.handle('e2e:subscribe', (ctx, session = 'session-acme') => registry.subscribe({
    clientId: ctx.clientId, sessionId: session, dir: join(dir, session), workspaceRootPath: dir, foreground: true,
  }))
  server.handle('e2e:details', async (ctx, session = 'session-acme') => {
    const state = registry.cachedSessionState(session)
    const entry = state?.kind === 'ready' ? state.prs[0] : null
    return entry ? registry.getDetails(session, entry.id, ctx.clientId) : null
  })
  await server.listen()
  teardown.push(() => server.close())
  const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, { token: TOKEN, autoReconnect: false, workspaceId: 'e2e' })
  client.on(RPC_CHANNELS.prWatch.CHANGED, (session: string, state: PrWatchSessionState) => pushed.push({ session, state }))
  teardown.push(() => client.destroy())
  client.connect()
  await until(() => server.getConnectedClientCount() === 1)
  // This invocation waits for the real handshake; its response also orders later assertions.
  await client.invoke('e2e:subscribe')
  if (options.start !== false) receiver.start()
  await until(() => pushed.some(item => options.noPr ? item.state.kind === 'none' : summary(item.state)?.number === 7))

  async function post(event: string, body: unknown, options: { id?: string; signature?: string; contentType?: string; raw?: string } = {}) {
    const raw = options.raw ?? JSON.stringify(body)
    const id = options.id ?? randomUUID()
    return fetch(`http://127.0.0.1:${server.port}${GITHUB_WEBHOOK_PATH}`, { method: 'POST',
      headers: { 'Content-Type': options.contentType ?? 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': id,
        'X-Hub-Signature-256': options.signature ?? `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}` }, body: raw })
  }
  return { dir, config, nodes, calls, changes, pushed, post, registry, client, statePath,
    url: `http://127.0.0.1:${server.port}`,
    get httpRequests() { return httpRequests },
    get activeHttpRequests() { return activeHttpRequests },
    setNoPr: (value: boolean) => { missingPr = value },
    setNumberSnapshot: (owner: string, node: GqlPullRequestSummary) => { historicalPrs.set(`${owner}/${node.number}`, structuredClone(node)) },
    setDetailTitle: (value: string) => { detailTitle = value },
    pauseNext: () => {
      nextGate = new Promise<void>(resolve => { release = resolve })
      const resume = () => { release?.(); release = null }
      teardown.push(resume)
      return resume
    },
    recreate: async () => {
      await receiver.stop()
      receiver = makeReceiver()
      httpHandler = createGithubWebhookHttpHandler(receiver, fallback)
      receiver.start()
    },
  }
}

function deliveryHeaders(body: string | Buffer) {
  return { 'Content-Type': 'application/json', 'X-GitHub-Event': 'ping', 'X-GitHub-Delivery': randomUUID(),
    'X-Hub-Signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}` }
}

/** Valid headers with a deliberately incomplete body; no payload can be accepted. */
function incompleteDelivery(url: string): ClientRequest {
  const req = request(`${url}${GITHUB_WEBHOOK_PATH}`, { method: 'POST',
    headers: { ...deliveryHeaders('{}'), 'Content-Length': 2 } })
  req.on('error', () => {}) // The test intentionally aborts the socket.
  req.on('response', res => res.resume())
  req.write('{')
  teardown.push(() => { req.destroy() })
  return req
}

describe('GitHub webhooks HTTP → durable inbox → registry → WebSocket', () => {
  it('updates the existing session and only its repository through a real WebSocket push', async () => {
    const h = await harness()
    await h.client.invoke('e2e:subscribe', 'session-unrelated')
    await until(() => h.calls.some(call => call.owner === 'unrelated'))
    const unrelatedReads = h.calls.filter(call => call.owner === 'unrelated').length
    h.nodes.acme!.mergeable = 'CONFLICTING'
    h.nodes.acme!.mergeStateStatus = 'DIRTY'
    const response = await h.post('pull_request', payload())
    expect(response.status).toBe(202)
    expect(readFileSync(h.statePath, 'utf8')).toContain('acme')
    await until(() => h.pushed.some(item => item.session === 'session-acme' && summary(item.state)?.mergeState === 'conflicting'))
    expect(h.calls.filter(call => call.owner === 'unrelated')).toHaveLength(unrelatedReads)
    expect(h.changes).toEqual(['acme/app'])
  })

  it('supports organization delivery/ping without WebUI and keeps ordinary HTTP routes separate', async () => {
    const h = await harness({ scopes: ['acme/*'] })
    expect((await h.post('ping', { zen: 'Keep it simple', hook: { type: 'Organization' } })).status).toBe(200)
    expect((await fetch(`${h.url}/not-a-webhook`)).status).toBe(404)
    h.nodes.acme!.reviewDecision = 'CHANGES_REQUESTED'
    expect((await h.post('pull_request_review', { ...payload(), action: 'submitted' })).status).toBe(202)
    await until(() => h.pushed.some(item => summary(item.state)?.reviewDecision === 'changes_requested'))
  })

  it('preserves an existing WebUI handler outside the webhook path', async () => {
    const h = await harness({ fallback: true })
    const response = await fetch(`${h.url}/existing`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('existing-webui')
    expect((await h.post('ping', {})).status).toBe(200)
  })

  it('rejects forged/unauthorized deliveries and ignores irrelevant events without GitHub reads', async () => {
    const h = await harness()
    const before = h.calls.length
    expect((await h.post('pull_request', payload(), { signature: `sha256=${'0'.repeat(64)}` })).status).toBe(401)
    expect((await h.post('pull_request', payload('unrelated/app'))).status).toBe(403)
    expect((await h.post('pull_request', {}, { raw: '{broken-json' })).status).toBe(400)
    expect((await h.post('pull_request', payload(), { contentType: 'application/x-www-form-urlencoded' })).status).toBe(415)
    expect((await h.post('pull_request', {}, { raw: 'x'.repeat(MAX_WEBHOOK_BYTES + 1) })).status).toBe(413)
    expect((await fetch(`${h.url}${GITHUB_WEBHOOK_PATH}`)).status).toBe(405)
    expect((await h.post('issues', { repository: { full_name: 'acme/app' } })).status).toBeLessThan(300)
    expect((await h.post('issue_comment', { repository: { full_name: 'acme/app' }, issue: { number: 99 } })).status).toBeLessThan(300)
    await Bun.sleep(350)
    expect(h.calls).toHaveLength(before)
    expect(h.changes).toHaveLength(0)
  })

  it('recovers accepted work after receiver recreation and deduplicates a redelivery', async () => {
    const h = await harness({ start: false })
    const delivery = randomUUID()
    h.nodes.acme!.reviewDecision = 'APPROVED'
    expect((await h.post('pull_request_review', payload(), { id: delivery })).status).toBe(202)
    expect(h.changes).toHaveLength(0)
    await h.recreate()
    await until(() => h.pushed.some(item => summary(item.state)?.reviewDecision === 'approved'))
    expect(h.changes).toEqual(['acme/app'])
    await h.recreate()
    const reads = h.calls.length
    expect((await h.post('pull_request_review', payload(), { id: delivery })).status).toBe(200)
    await Bun.sleep(350)
    expect(h.calls).toHaveLength(reads)
    expect(h.changes).toEqual(['acme/app'])
  })

  it('does not replay an accepted delivery after its repository authorization is removed', async () => {
    const h = await harness({ start: false })
    const reads = h.calls.length
    expect((await h.post('pull_request', payload())).status).toBe(202)
    h.config.repositories = ['unrelated/*']
    await h.recreate()
    await Bun.sleep(350)
    expect(h.changes).toHaveLength(0)
    expect(h.calls).toHaveLength(reads)
  })

  it('refetches after an older in-flight read rather than dropping the webhook', async () => {
    const h = await harness()
    const reads = h.calls.length
    const release = h.pauseNext()
    const oldRead = h.registry.nudge('session-acme')
    await until(() => h.calls.length === reads + 1)
    h.nodes.acme!.mergeable = 'CONFLICTING'
    h.nodes.acme!.mergeStateStatus = 'DIRTY'
    expect((await h.post('pull_request', payload())).status).toBe(202)
    await until(() => h.changes.length === 1)
    release()
    await oldRead
    await until(() => h.pushed.some(item => summary(item.state)?.mergeState === 'conflicting'))
    expect(h.calls.length).toBeGreaterThanOrEqual(reads + 2)
  })

  it('discovers a newly opened PR for a tracked branch without waiting for fallback polling', async () => {
    const h = await harness({ noPr: true })
    h.setNoPr(false)
    expect((await h.post('pull_request', { ...payload(), action: 'opened' })).status).toBe(202)
    await until(() => h.pushed.some(item => summary(item.state)?.number === 7))
    expect(h.changes).toEqual(['acme/app'])
  })

  it('discovers a replacement PR when old and new PR deliveries for a reused branch are coalesced', async () => {
    const h = await harness()
    h.nodes.acme!.state = 'CLOSED'
    await h.registry.nudge('session-acme')
    await until(() => h.pushed.some(item => summary(item.state)?.state === 'closed'))
    h.setNumberSnapshot('acme', h.nodes.acme!)
    expect((await h.post('pull_request', { ...payload(), action: 'closed' })).status).toBe(202)
    h.nodes.acme = { ...pr(), id: 'PR_acme_8', number: 8, url: 'https://github.com/acme/app/pull/8' }
    const opened = payload()
    opened.action = 'opened'
    opened.pull_request.number = 8
    expect((await h.post('pull_request', opened)).status).toBe(202)
    await until(() => h.pushed.some(item => summary(item.state)?.number === 8 && summary(item.state)?.state === 'open'))
    expect(summary(h.registry.cachedSessionState('session-acme')!)?.number).toBe(8)
  })

  it('handles CI events with an empty pull_requests list by matching the head SHA', async () => {
    const h = await harness()
    h.nodes.acme!.mergeStateStatus = 'BLOCKED'
    h.nodes.acme!.commits.nodes[0]!.commit.statusCheckRollup = { state: 'FAILURE' }
    expect((await h.post('check_run', { repository: { full_name: 'acme/app' },
      action: 'completed', check_run: { head_sha: SHA, pull_requests: [] } })).status).toBe(202)
    await until(() => h.pushed.some(item => summary(item.state)?.checks === 'failure'))
  })

  it('invalidates detail data after a same-head review event', async () => {
    const h = await harness()
    await h.client.invoke('e2e:details')
    const before = h.calls.filter(call => call.query.includes('PrDetails')).length
    h.setDetailTitle('After review')
    h.nodes.acme!.reviewDecision = 'APPROVED'
    expect((await h.post('pull_request_review', payload())).status).toBe(202)
    await until(() => h.pushed.some(item => summary(item.state)?.reviewDecision === 'approved'))
    await h.client.invoke('e2e:details')
    expect(h.calls.filter(call => call.query.includes('PrDetails'))).toHaveLength(before + 1)
  })

  it('does not let an older in-flight details response repopulate an invalidated cache', async () => {
    const h = await harness()
    const release = h.pauseNext()
    const olderDetails = h.client.invoke('e2e:details')
    await until(() => h.calls.some(call => call.query.includes('PrDetails')))
    h.nodes.acme!.reviewDecision = 'APPROVED'
    expect((await h.post('pull_request_review', payload())).status).toBe(202)
    await until(() => h.pushed.some(item => summary(item.state)?.reviewDecision === 'approved'))
    release()
    await olderDetails
    await h.client.invoke('e2e:details')
    expect(h.calls.filter(call => call.query.includes('PrDetails'))).toHaveLength(2)
  })

  it('does not apply local status computed for an old HEAD after a synchronize delivery', async () => {
    const h = await harness({ localForHead: head => ({ localAhead: head === SHA ? 0 : 3, localDirty: false,
      headMatchesLocal: head === SHA }) })
    const release = h.pauseNext()
    const olderDetails = h.client.invoke('e2e:details')
    await until(() => h.calls.some(call => call.query.includes('PrDetails')))
    const nextSha = 'b'.repeat(40)
    h.nodes.acme!.headRefOid = nextSha
    const change = payload()
    change.pull_request.head.sha = nextSha
    expect((await h.post('pull_request', change)).status).toBe(202)
    await until(() => h.pushed.some(item => summary(item.state)?.headOid === nextSha && summary(item.state)?.localAhead === 3))
    release()
    await olderDetails
    expect(summary(h.registry.cachedSessionState('session-acme')!)?.localAhead).toBe(3)
    expect(summary(h.pushed.at(-1)?.state)?.headMatchesLocal).toBe(false)
  })

  it('bounds incomplete requests at 16 and recovers capacity when their clients abort', async () => {
    const h = await harness()
    const before = h.httpRequests
    const pending = Array.from({ length: 16 }, () => incompleteDelivery(h.url))
    await until(() => h.httpRequests === before + 16)
    expect((await h.post('ping', {})).status).toBe(503)
    expect(h.changes).toHaveLength(0)
    for (const req of pending) req.destroy()
    await until(() => h.activeHttpRequests === 0)
    expect((await h.post('ping', {})).status).toBe(200)
    expect(existsSync(h.statePath)).toBe(false)
  })

  it('survives a client disconnect during body reception without accepting partial work', async () => {
    const h = await harness()
    const reads = h.calls.length
    const before = h.httpRequests
    const pending = incompleteDelivery(h.url)
    await until(() => h.httpRequests === before + 1)
    pending.destroy()
    await until(() => h.activeHttpRequests === 0)
    expect((await h.post('ping', {})).status).toBe(200)
    expect(h.changes).toHaveLength(0)
    expect(h.calls).toHaveLength(reads)
    expect(existsSync(h.statePath)).toBe(false)
  })

  it('rejects an oversized chunked body without persisting work and stays available', async () => {
    const h = await harness()
    const body = Buffer.alloc(MAX_WEBHOOK_BYTES + 1, 'x')
    const outcome = await new Promise<number | 'disconnected'>((resolve, reject) => {
      const req = request(`${h.url}${GITHUB_WEBHOOK_PATH}`, { method: 'POST',
        headers: { ...deliveryHeaders(body), 'Transfer-Encoding': 'chunked' } }, res => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      const timeout = setTimeout(() => { req.destroy(); reject(new Error('Chunked request did not settle')) }, 3000)
      req.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNRESET' || error.code === 'EPIPE') resolve('disconnected')
        else reject(error)
      })
      req.once('close', () => clearTimeout(timeout))
      teardown.push(() => { clearTimeout(timeout); req.destroy() })
      req.write(body.subarray(0, MAX_WEBHOOK_BYTES / 2))
      req.write(body.subarray(MAX_WEBHOOK_BYTES / 2, MAX_WEBHOOK_BYTES))
      req.end(body.subarray(MAX_WEBHOOK_BYTES))
    })
    // Ending the bounded async body iterator may close the socket before its 413 is flushed.
    expect(outcome === 413 || outcome === 'disconnected').toBe(true)
    await until(() => h.activeHttpRequests === 0)
    expect((await h.post('ping', {})).status).toBe(200)
    expect(h.changes).toHaveLength(0)
    expect(existsSync(h.statePath)).toBe(false)
  })

  it('processes a sustained delivery burst while arrivals continue instead of starving the inbox', async () => {
    const h = await harness()
    for (let i = 0; i < 6; i++) {
      expect((await h.post('pull_request', payload())).status).toBe(202)
      await Bun.sleep(90)
      if (i === 4) expect(h.changes.length).toBeGreaterThan(0)
    }
    await until(() => h.changes.length > 0)
  })
})
