import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ISessionManager } from '../../handlers/session-manager-interface'
import type { PrWatchRegistry } from '../pr-watch/registry'
import type { PrWatchSessionState } from '@craft-agent/shared/protocol'
import { SessionAttentionService } from './service'

it('monitors all non-archived repository sessions without a renderer, and disposes every subscription', async () => {
  const root = mkdtempSync(join(tmpdir(), 'craft-attention-service-'))
  const sessions = [ { id: 'project-open', workspaceId: 'w', workingDirectory: '/repo/1' }, { id: 'project-closed', workspaceId: 'w', workingDirectory: '/repo/2' }, { id: 'archived', workspaceId: 'w', workingDirectory: '/repo/3', isArchived: true } ]
  const subscribed: string[] = []; const released: string[] = []
  let listener: ((id: string, state: PrWatchSessionState) => void) | undefined
  const registry = { onSessionState: (fn: typeof listener) => { listener = fn; return () => { listener = undefined } },
    subscribe: async (input: { sessionId: string }) => { subscribed.push(input.sessionId); return { subscriptionId: input.sessionId, state: { kind: 'loading' } } },
    unsubscribe: (id: string) => { released.push(id) }, dropClient: () => { released.push(...subscribed.filter(id => !released.includes(id))) }, cachedSessionState: () => null,
  } as unknown as PrWatchRegistry
  const manager = { waitForInit: async () => {}, getSessions: () => sessions, getSessionSnapshot: (id: string) => sessions.find(s => s.id === id), getSessionWorkingDirectory: () => undefined,
    getSessionBoundPrs: () => [], getSessionPrMonitors: () => ({}),
  } as unknown as ISessionManager
  const service = new SessionAttentionService({ manager, workspaceRoot: () => root, push: () => {} })
  try {
    service.start(registry); await service.sync()
    expect(subscribed).toEqual(['project-open', 'project-closed'])
    service.setReasons('project-closed', 'agent', [{ id: 'q', source: 'agent', kind: 'question', title: 'Choose deployment target', createdAt: 1, action: { type: 'session' } }])
    expect(service.snapshot('w').sessions['project-closed']?.status).toBe('needs-human')
    listener?.('project-closed', { kind: 'unavailable', reason: 'error' })
    expect(service.snapshot('w').sessions['project-closed']?.reasons[0]?.title).toBe('Choose deployment target')
    service.resolve('project-closed', 'auth')
    expect(service.snapshot('w').sessions['project-closed']?.reasons).toHaveLength(1)
    service.resolve('project-closed', 'agent', 'q')
    expect(service.snapshot('w').sessions['project-closed']?.status).toBe('idle')
    service.dispose()
    expect(released.sort()).toEqual(['project-closed', 'project-open'])
    expect(listener).toBeUndefined()
  } finally { service.dispose(); rmSync(root, { recursive: true, force: true }) }
})

it('preserves simultaneous auth and permission prompts and resolves only the answered action', () => {
  const root = mkdtempSync(join(tmpdir(), 'craft-attention-prompts-'))
  const manager = { getSessionSnapshot: (id: string) => ({ id, workspaceId: 'w' }) } as unknown as ISessionManager
  const service = new SessionAttentionService({ manager, workspaceRoot: () => root, push: () => {} })
  try {
    for (const source of ['auth', 'permission'] as const) {
      for (const id of ['first', 'second']) service.upsertReason('s', { id: `${source}:${id}`, source, kind: source === 'auth' ? 'authentication' : 'permission', title: `${source} ${id}`, createdAt: 1, action: { type: 'session' } })
    }
    expect(service.snapshot('w').sessions.s?.reasons).toHaveLength(4)
    service.resolve('s', 'auth', 'auth:first')
    expect(service.snapshot('w').sessions.s?.reasons.map(r => r.id).sort()).toEqual(['auth:second', 'permission:first', 'permission:second'])
    service.resolve('s', 'permission', 'permission:first')
    expect(service.snapshot('w').sessions.s?.reasons.map(r => r.id).sort()).toEqual(['auth:second', 'permission:second'])
    expect(service.snapshot('w').sessions.s?.status).toBe('needs-human')
    service.upsertReason('s', { id: 'auth:second', source: 'auth', kind: 'authentication', title: 'Updated auth label', createdAt: 20, action: { type: 'session' } })
    expect(service.snapshot('w').sessions.s?.reasons.filter(r => r.id === 'auth:second')).toHaveLength(1)
    expect(service.snapshot('w').sessions.s?.reasons.find(r => r.id === 'auth:second')?.createdAt).toBe(1)
  } finally { service.dispose(); rmSync(root, { recursive: true, force: true }) }
})

it('background recovery respects the registry retry deadline instead of forcing requests each minute', async () => {
  const { PrWatchRegistry } = await import('../pr-watch/registry')
  const { GitHubRequestError } = await import('../pr-watch/github-client')
  const root = mkdtempSync(join(tmpdir(), 'craft-attention-backoff-'))
  let now = 1_000_000
  let calls = 0
  const session = { id: 'limited', workspaceId: 'w', workingDirectory: '/repo' }
  const registry = new PrWatchRegistry({
    graphql: async () => { calls++; throw new GitHubRequestError('rate limited', 429, 5 * 60_000) },
    candidates: async () => [{ id: 'gh', label: 'gh', getToken: async () => 'token' }],
    push: () => {}, now: () => now,
    resolveRepo: async () => ({ root: '/repo', gitDir: '/repo/.git', commonDir: '/repo/.git', branch: 'topic', pushRemote: 'origin', remoteBranch: 'topic', repo: { host: 'github.com', owner: 'acme', repo: 'app' }, upstreamRepo: null }),
    watchRefs: () => () => {}, setTimer: () => 1, clearTimer: () => {},
  })
  const manager = {
    waitForInit: async () => {}, getSessions: () => [session], getSessionSnapshot: () => session,
    getSessionWorkingDirectory: () => '/repo', getSessionBoundPrs: () => [], getSessionPrMonitors: () => ({}),
  } as unknown as ISessionManager
  const service = new SessionAttentionService({ manager, workspaceRoot: () => root, push: () => {} })
  try {
    service.start(registry); await service.sync()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toBe(1)
    for (let minute = 1; minute <= 4; minute++) { now += 60_000; await service.sync() }
    expect(calls).toBe(1)
    now += 60_000; await service.sync()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toBe(2)
  } finally { service.dispose(); registry.dispose(); rmSync(root, { recursive: true, force: true }) }
})
