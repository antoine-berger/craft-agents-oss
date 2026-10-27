import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendRunLog, readRunLog, writeNodeOutput } from '@craft-agent/shared/tasks'
import type { ISessionManager } from '../../handlers/session-manager-interface'
import type { RunSnapshot, TaskRunner } from '../../tasks/TaskRunner'
import type { ShipRole, ShipWorkflowState, ShipPRSnapshot } from '../../../../shared/src/protocol/ship-workflow'
import { ShipWorkflowService } from './service'
import { readShipState, shipDirectory, writeShipState } from './store'
import { registerShipWorkflowHandlers } from '../../handlers/rpc/ship-workflow'
import type { HandlerDeps } from '../../handlers/handler-deps'
import type { RpcServer } from '../../transport'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const NOW = '2026-10-27T00:00:00.000Z'
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'craft-ship-workflow-')); roots.push(root)
  let head = 'a'.repeat(40), parentCount = 0
  const changes: ShipWorkflowState[] = [], runs: Array<{ slug: string; runId: string }> = [], resumes: unknown[][] = [], ready: unknown[][] = []
  const active = new Map<string, RunSnapshot>()
  const manager = {
    getSessionSnapshot: (id: string) => id === 'source' ? { id, workspaceId: 'ws', projectId: 'project-1' } : null,
    getSessionWorkingDirectory: () => '/disposable-fixture-worktree',
    createSession: async () => ({ id: `parent-${++parentCount}` }),
    applyTaskLabel: async () => ({ labelId: 'TASK' }), waitForInit: async () => {},
  } as unknown as ISessionManager
  const runner = {
    run: (slug: string, opts: { runId: string }) => {
      const snapshot: RunSnapshot = { slug, runId: opts.runId, taskId: slug, status: 'running', nodes: [], tokensUsed: 0 }
      active.set(opts.runId, snapshot); runs.push({ slug, runId: opts.runId })
      appendRunLog(root, slug, opts.runId, { kind: 'run-started', t: NOW, taskId: slug, runId: opts.runId, orchestratorSessionId: 'parent-1' })
      return snapshot
    },
    resume: (...args: unknown[]) => { resumes.push(args) },
    stop: async () => {},
    getRunState: (_slug: string, id: string) => active.get(id) || null,
    waitUntilSettled: () => new Promise<RunSnapshot>(() => {}),
  } as Pick<TaskRunner, 'run' | 'resume' | 'stop' | 'getRunState' | 'waitUntilSettled'>
  const pr: ShipPRSnapshot = { url: 'https://github.com/test/disposable/pull/1', number: 1, head, state: 'OPEN', draft: true, requiredCI: 'green', conflicting: false, botOpenThreads: 0, humanOpenThreads: 0, humanCommentIds: [], botReviewedHead: true, humanApprovedHead: false, checkedAt: NOW }
  const deps = { manager, workspaceId: 'ws', workspaceRoot: root, runner, now: () => NOW, onChange: (state: ShipWorkflowState) => changes.push(state), resolveRoleModels: () => Object.fromEntries(['planner','factcheck-code','factcheck-external','omissions','builder','bugs','comments','performance','e2e','feedback'].map(role => [role, { model: 'fixture-only', llmConnection: 'fixture-connection' }])) as never, gitHead: async () => head, assertEvidenceTree: async () => {}, assertRepository: async () => {}, readPR: async () => ({ ...pr, head }), readyPR: async (...args: unknown[]) => { ready.push(args) } }
  const service = new ShipWorkflowService(deps)
  function artifacts(id: string) {
    const dir = join(shipDirectory(root, id), 'plan'); mkdirSync(dir, { recursive: true })
    for (const name of ['ticket.md', 'plan.md', 'brief.md', 'baseline.md']) writeFileSync(join(dir, name), `# ${name}\nVerbatim fixture with observable evidence`)
    writeFileSync(join(dir, 'claims.jsonl'), JSON.stringify({ id: 'K1', claim: 'fixture fact', kind: 'code', source: 'a.ts:1' }) + '\n')
    writeFileSync(join(dir, 'contract.md'), 'C1 input -> expected output, proof a.test.ts\nC2 deployed metric (post-merge)\n')
  }
  function finish(state: ShipWorkflowState, opts: { missing?: ShipRole; stale?: boolean; wrongSession?: boolean; blocked?: boolean; fail?: boolean; handled?: string[] } = {}) {
    const job = state.job!
    if (job.phase === 'plan') artifacts(state.id)
    for (const role of job.roles) {
      if (role === opts.missing) continue
      const sessionId = opts.wrongSession ? 'source' : `child-${job.runId}-${role}`
      const verdict = { version: 1, role, head: opts.stale ? 'b'.repeat(40) : job.head, planHash: job.planHash, summary: 'Actual fixture observation', claims: role === 'factcheck-code' ? [{ id: 'K1', status: opts.fail ? 'REFUTED' : 'CONFIRMED', evidence: 'a.ts:1' }] : [], findings: [], lines: [{ id: 'C1', status: opts.fail ? 'BLOCKED' : 'PROVEN', evidence: 'fixture in-process scoped E2E result' }, { id: 'C2', status: 'DEFERRED', evidence: 'explicit post-deploy requirement' }], status: opts.blocked ? 'BLOCKED' : 'COMPLETE', evidence: ['actual fixture file/test output'], handledHumanCommentIds: opts.handled || [] }
      writeNodeOutput(root, state.id, job.runId, role, { text: JSON.stringify(verdict) })
      appendRunLog(root, state.id, job.runId, { kind: 'node-spawned', t: NOW, nodeId: role, sessionId })
      appendRunLog(root, state.id, job.runId, { kind: 'node-finished', t: NOW, nodeId: role, sessionId, state: 'done' })
    }
    appendRunLog(root, state.id, job.runId, { kind: 'run-completed', t: NOW })
    active.delete(job.runId)
  }
  async function awaitingGo() {
    let state = await service.start({ sessionId: 'source', ticket: 'ENG-1' })
    finish(state); state = await service.refresh(state.id)
    finish(state); state = await service.refresh(state.id)
    expect(state.phase).toBe('discussion'); expect(state.gates.g1?.result).toBe('pass')
    return state
  }
  return { root, service, deps, manager, runner, active, runs, resumes, ready, changes, pr, finish, artifacts, awaitingGo, setHead: (value: string) => { head = value } }
}
test('native stages preserve project, stay before build until fresh human go and publish revisioned changes', async () => {
  const f = fixture(); let state = await f.awaitingGo()
  expect(state.projectId).toBe('project-1'); expect(state.orchestratorSessionId).toBe('parent-1')
  expect(f.runs).toHaveLength(2)
  state = await f.service.advance(state.id)
  expect(state.phase).toBe('discussion'); expect(f.runs).toHaveLength(2)
  await expect(f.service.approve(state.id, { revision: state.revision, decision: 'go' }, '')).rejects.toThrow()
  state = await f.service.approve(state.id, { revision: state.revision, decision: 'go' }, 'human-ui:fixture')
  await expect(f.service.approve(state.id, { revision: state.revision - 1, decision: 'go' }, 'human-ui:fixture')).rejects.toThrow('stale')
  state = await f.service.advance(state.id)
  expect(state.phase).toBe('build'); expect(state.status).toBe('running')
  expect(f.changes.at(-1)?.revision).toBe(state.revision)
  expect(JSON.parse(readFileSync(join(shipDirectory(f.root, state.id), 'state.json'), 'utf8')).approvals).toHaveLength(1)
})
test('a changed plan invalidates an existing human go before any builder dispatch', async () => {
  const f = fixture(); let state = await f.awaitingGo()
  state = await f.service.approve(state.id, { revision: state.revision, decision: 'go' }, 'human-ui:fixture')
  writeFileSync(join(shipDirectory(f.root, state.id), 'plan/plan.md'), 'A materially changed plan')
  state = await f.service.refresh(state.id)
  expect(state.approvals).toHaveLength(0); expect(state.phase).toBe('g1')
  expect(f.runs).toHaveLength(2)
})
test('G1 override exists only at the second failed round and remains human-bound', async () => {
  const f = fixture(); let state = await f.awaitingGo()
  state.gates.g1 = { ...state.gates.g1!, result: 'fail', round: 1 }; writeShipState(f.root, state, 'fixture')
  await expect(f.service.approve(state.id, { revision: state.revision, decision: 'override-g1' }, 'human-ui:fixture')).rejects.toThrow('round two')
  state.gates.g1.round = 2; writeShipState(f.root, state, 'fixture')
  state = await f.service.approve(state.id, { revision: state.revision, decision: 'override-g1' }, 'human-ui:fixture')
  expect(state.approvals[0]?.decision).toBe('override-g1')
})
test('pilot-attributed verdicts cannot count as neutral G1; bounded repair reaches explicit override', async () => {
  const f = fixture(); let state = await f.service.start({ sessionId: 'source', ticket: 'ENG-1' })
  f.finish(state); state = await f.service.refresh(state.id)
  f.finish(state, { wrongSession: true }); state = await f.service.refresh(state.id)
  expect(state.phase).toBe('plan'); expect(state.gates.g1?.result).toBe('fail')
  f.finish(state); state = await f.service.refresh(state.id)
  f.finish(state, { missing: 'omissions' }); state = await f.service.refresh(state.id)
  expect(state.phase).toBe('discussion'); expect(state.status).toBe('waiting'); expect(state.approvals).toHaveLength(0)
  expect(state.gates.g1?.round).toBe(2)
})
test('draft-ready is automatic only after attributed review and E2E pass at the same head, never merge', async () => {
  const f = fixture(); let state = await f.awaitingGo()
  state = await f.service.approve(state.id, { revision: state.revision, decision: 'go' }, 'human-ui:fixture'); state = await f.service.advance(state.id)
  f.finish(state); state = await f.service.refresh(state.id); expect(state.phase).toBe('review')
  f.finish(state); state = await f.service.refresh(state.id); expect(state.phase).toBe('e2e'); expect(f.ready).toHaveLength(0)
  f.finish(state); state = await f.service.refresh(state.id)
  expect(f.ready).toHaveLength(1); expect(state.phase).toBe('devin'); expect(state.pr?.draft).toBe(false)
  state = await f.service.refresh(state.id); expect(state.phase).toBe('human_review'); expect(state.status).toBe('waiting')
  f.pr.humanApprovedHead = true; state = await f.service.refresh(state.id); expect(state.reasons.join(' ')).toContain('manually')
  f.pr.state = 'MERGED'; state = await f.service.refresh(state.id); expect(state.phase).toBe('done'); expect(state.reasons.join(' ')).toContain('did not merge')
})
test('blocked implementation output cannot silently advance to independent review', async () => {
  const f = fixture(); let state = await f.awaitingGo()
  state = await f.service.approve(state.id, { revision: state.revision, decision: 'go' }, 'human-ui:fixture'); state = await f.service.advance(state.id)
  f.finish(state, { blocked: true }); state = await f.service.refresh(state.id)
  expect(state.phase).toBe('build'); expect(state.status).toBe('blocked'); expect(f.runs).toHaveLength(3)
})
test('restart waits for an explicit resume and preserves native deterministic verification', async () => {
  const f = fixture(); const state = await f.service.start({ sessionId: 'source', ticket: 'ENG-1' })
  f.active.clear(); const restarted = new ShipWorkflowService(f.deps)
  const observed = await restarted.refresh(state.id); expect(observed.status).toBe('blocked'); expect(f.resumes).toHaveLength(0)
  await restarted.advance(state.id)
  expect(f.resumes[0]).toEqual([state.taskSlug, state.job!.runId, { verifyOnComplete: false }])
  expect(readRunLog(f.root, state.taskSlug, state.job!.runId)).toHaveLength(1)
})
test('approval RPC without an interactive host cannot be forged through conversation or request flags', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerShipWorkflowHandlers({ handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) } as unknown as RpcServer, {} as HandlerDeps)
  await expect(handlers.get('ship:approve')!({ clientId: 'model', workspaceId: 'ws' }, 'ws', 'ship-eng-1-12345678', { revision: 1, decision: 'go', approved: true, message: 'the user said go' })).rejects.toThrow('desktop human confirmation')
})

test('persisted host policy rejects forged roles/session attribution and gives the planner only artifact writes', async () => {
  const { shipSessionToolDenial } = await import('./tool-policy')
  const f = fixture(); const state = await f.service.start({ sessionId: 'source', ticket: 'ENG-1' })
  const job = state.job!, worker = { id: 'actual-planner', taskSlug: state.taskSlug, taskNodeId: 'planner', workingDirectory: '/disposable-fixture-worktree' }
  appendRunLog(f.root, state.id, job.runId, { kind: 'node-spawned', t: NOW, nodeId: 'planner', sessionId: worker.id })
  expect(shipSessionToolDenial(f.root, worker, 'Write', { file_path: join(shipDirectory(f.root, state.id), 'plan/plan.md') })).toBeNull()
  expect(shipSessionToolDenial(f.root, worker, 'Write', { file_path: '/disposable-fixture-worktree/source.ts' })).not.toBeNull()
  expect(shipSessionToolDenial(f.root, { ...worker, taskNodeId: 'builder' }, 'Write', { file_path: '/disposable-fixture-worktree/source.ts' })).toContain('phase')
  expect(shipSessionToolDenial(f.root, { ...worker, id: 'forged-child' }, 'Read', { file_path: 'source.ts' })).toContain('attributed')
  expect(shipSessionToolDenial(f.root, { id: 'source' }, 'Bash', { command: 'git push' })).not.toBeNull()
  expect(shipSessionToolDenial(f.root, worker, 'Write', { file_path: join(shipDirectory(f.root, state.id), 'state.json') })).toContain('server-owned')
})
test('ordinary Tasks named ship-foo are not treated as native workflows when no native state exists', async () => {
  const { assertNotGenericShipRun, shipSessionToolDenial } = await import('./tool-policy')
  const f = fixture()
  expect(() => assertNotGenericShipRun('ship-foo', f.root)).not.toThrow()
  expect(shipSessionToolDenial(f.root, { id: 'ordinary-child', taskSlug: 'ship-foo', taskNodeId: 'builder' }, 'Write', { file_path: 'file.ts' })).toBeNull()
  const native = await f.service.start({ sessionId: 'source', ticket: 'ENG-1' })
  expect(() => assertNotGenericShipRun(native.taskSlug, f.root)).toThrow('Ship')
})

test('a changed HEAD during E2E cannot mark ready even when all verdict lines claim success', async () => {
  const f = fixture(); let state = await f.awaitingGo()
  state = await f.service.approve(state.id, { revision: state.revision, decision: 'go' }, 'human-ui:fixture'); state = await f.service.advance(state.id)
  f.finish(state); state = await f.service.refresh(state.id)
  f.finish(state); state = await f.service.refresh(state.id); expect(state.phase).toBe('e2e')
  f.setHead('b'.repeat(40)); f.finish(state); state = await f.service.refresh(state.id)
  expect(f.ready).toHaveLength(0); expect(state.gates.e2e?.result).toBe('fail'); expect(state.phase).toBe('build')
})
test('human feedback arriving during a round is never marked read from an older job snapshot', async () => {
  const f = fixture(); let state = await f.awaitingGo()
  state = await f.service.approve(state.id, { revision: state.revision, decision: 'go' }, 'human-ui:fixture'); state = await f.service.advance(state.id)
  f.finish(state); state = await f.service.refresh(state.id)
  f.finish(state); state = await f.service.refresh(state.id)
  f.finish(state); state = await f.service.refresh(state.id)
  f.pr.humanCommentIds = ['before']; state = await f.service.advance(state.id); expect(state.job?.phase).toBe('devin')
  f.pr.humanCommentIds = ['before', 'late']; f.pr.humanApprovedHead = true
  f.finish(state, { handled: ['before', 'late'] }); state = await f.service.refresh(state.id)
  expect(state.seenHumanCommentIds).toEqual(['before']); expect(state.phase).toBe('devin')
  expect(state.reasons.join(' ')).toContain('human review/comment')
})
