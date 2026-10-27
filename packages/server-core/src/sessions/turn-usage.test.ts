import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveSession } from '../../../shared/src/sessions/storage.ts'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { addTurnUsage, branchStartTotals, type CumulativeUsage } from './turn-usage.ts'

const turn = (costUsd: number, outputTokens: number) => ({
  inputTokens: 1000,
  outputTokens: 7, // main loop only; ignored when running totals are present
  costUsd,
  runningTotals: { costUsd, outputTokens },
})

describe('addTurnUsage', () => {
  it('sums per-turn usage from backends without running totals (Pi)', () => {
    const usage: CumulativeUsage = { outputTokens: 0, costUsd: 0 }
    addTurnUsage(usage, { inputTokens: 1000, outputTokens: 300, costUsd: 0.25 })
    addTurnUsage(usage, { inputTokens: 1200, outputTokens: 200, costUsd: 0.5 })
    expect(usage).toEqual({ outputTokens: 500, costUsd: 0.75 })
  })

  it('adds only the change in running totals, so earlier turns are not counted again', () => {
    const usage: CumulativeUsage = { outputTokens: 0, costUsd: 0 }
    addTurnUsage(usage, turn(1, 100))
    addTurnUsage(usage, turn(3, 250))
    addTurnUsage(usage, turn(6, 400))
    expect(usage.costUsd).toBe(6)
    expect(usage.outputTokens).toBe(400)
    expect(usage.lastRunningTotals).toEqual({ costUsd: 6, outputTokens: 400 })
  })

  it('counts totals in full after the backend restarts counting (/clear, new SDK session)', () => {
    const usage: CumulativeUsage = { outputTokens: 400, costUsd: 6, lastRunningTotals: { costUsd: 6, outputTokens: 400 } }
    addTurnUsage(usage, turn(0.5, 50))
    expect(usage.costUsd).toBe(6.5)
    expect(usage.outputTokens).toBe(450)
  })

  it('continues from persisted totals when a resumed session reports its saved total', () => {
    const usage: CumulativeUsage = { outputTokens: 400, costUsd: 6, lastRunningTotals: { costUsd: 6, outputTokens: 400 } }
    addTurnUsage(usage, turn(7, 480))
    expect(usage.costUsd).toBe(7)
    expect(usage.outputTokens).toBe(480)
  })

  it('skips zeroed crash/startup results without losing the baseline', () => {
    const usage: CumulativeUsage = { outputTokens: 400, costUsd: 6, lastRunningTotals: { costUsd: 6, outputTokens: 400 } }
    addTurnUsage(usage, turn(0, 0))
    addTurnUsage(usage, turn(7, 480))
    expect(usage.costUsd).toBe(7)
    expect(usage.outputTokens).toBe(480)
  })
})

describe('branchStartTotals', () => {
  const parent = { sdkSessionId: 'parent-sdk', tokenUsage: { lastRunningTotals: { costUsd: 6, outputTokens: 400 } } }

  it("starts a branch from the parent's counted totals when it forked the parent's current SDK session", () => {
    expect(branchStartTotals(parent, 'parent-sdk')).toEqual({ costUsd: 6, outputTokens: 400 })
    expect(branchStartTotals({ ...parent, sdkSessionId: 'newer-sdk' }, 'parent-sdk')).toBeUndefined()
    expect(branchStartTotals({ sdkSessionId: 'parent-sdk', tokenUsage: {} }, 'parent-sdk')).toBeUndefined()
    expect(branchStartTotals(null, 'parent-sdk')).toBeUndefined()
  })

  it("counts only the branch's own spend whether or not the fork carried the parent's total", () => {
    // Parent process had exited: the fork's first result continues from the parent's saved total.
    const afterExit: CumulativeUsage = { outputTokens: 0, costUsd: 0, lastRunningTotals: branchStartTotals(parent, 'parent-sdk') }
    addTurnUsage(afterExit, turn(6.5, 450))
    expect(afterExit).toMatchObject({ costUsd: 0.5, outputTokens: 50 })

    // Parent process still running: nothing was saved yet, so the fork starts counting from zero.
    const whileRunning: CumulativeUsage = { outputTokens: 0, costUsd: 0, lastRunningTotals: branchStartTotals(parent, 'parent-sdk') }
    addTurnUsage(whileRunning, turn(0.5, 50))
    expect(whileRunning).toMatchObject({ costUsd: 0.5, outputTokens: 50 })
  })
})

describe('SessionManager turn usage', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-turn-usage-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('keeps a Claude session cost at the SDK running total instead of the sum of totals', async () => {
    const id = 'running-totals'
    const workspace = { id: 'ws-test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() }
    const managed = createManagedSession({ id, name: 'turn usage test' }, workspace as never, { messagesLoaded: true })
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    await saveSession({ id, workspaceRootPath: tmpRoot, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } } as any)
    const totals = [turn(1, 100), turn(3, 250), turn(6, 400)]
    const agent = {
      getModel: () => 'claude-opus-5-5',
      setAllSources: () => {},
      // No source transports in this fixture; keep the normal source synchronization boundary.
      getSummarizeCallback: () => undefined,
      setSourceServers: async () => {},
      getSessionId: () => 'sdk-session',
      chat: async function* () {
        yield { type: 'complete', usage: totals.shift() }
      },
    }
    ;(sm as any).getOrCreateAgent = async () => agent
    ;(sm as any).startPreTurnDecisions = async () => ({ thinkingOverride: null, suggestionHint: null })
    sm.setEventSink(() => {})

    await sm.sendMessage(id, 'one')
    await sm.sendMessage(id, 'two')
    await sm.sendMessage(id, 'three')

    expect(managed.tokenUsage?.costUsd).toBe(6) // the sum of the totals would be 10
    expect(managed.tokenUsage?.outputTokens).toBe(400)
  })

  it("reads a branch's parent from memory, else from its header on disk", async () => {
    const workspace = { id: 'ws-test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() }
    const tokenUsage = { inputTokens: 0, outputTokens: 400, totalTokens: 400, contextTokens: 0, costUsd: 6, lastRunningTotals: { costUsd: 6, outputTokens: 400 } }
    await saveSession({ id: 'parent', workspaceRootPath: tmpRoot, sdkSessionId: 'parent-sdk', createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage } as any)
    const branch = createManagedSession({ id: 'branch', name: 'branch' }, workspace as never, { branchFromSessionPath: join(tmpRoot, 'sessions', 'parent') })
    const branchParent = (managed: unknown) => (sm as any).branchParent(managed)

    expect(branchParent(branch)).toMatchObject({ sdkSessionId: 'parent-sdk', tokenUsage: { lastRunningTotals: { costUsd: 6, outputTokens: 400 } } })

    const live = createManagedSession({ id: 'parent', name: 'parent' }, workspace as never, { messagesLoaded: true })
    live.sdkSessionId = 'parent-sdk'
    live.tokenUsage = { ...tokenUsage, costUsd: 9, lastRunningTotals: { costUsd: 9, outputTokens: 600 } }
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('parent', live)
    expect(branchParent(branch)?.tokenUsage?.lastRunningTotals).toEqual({ costUsd: 9, outputTokens: 600 })

    expect(branchParent(createManagedSession({ id: 'plain', name: 'plain' }, workspace as never, {}))).toBeNull()
  })
})
