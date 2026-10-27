import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getLlmConnections } from '@craft-agent/shared/config/storage'
import { saveTaskSpec, readRunLog, readNodeOutput, type TaskSpec } from '@craft-agent/shared/tasks'
import { createTaskFromSpec } from '../../tasks/create-task'
import { TaskRunner } from '../../tasks/TaskRunner'
import type { ISessionManager } from '../../handlers/session-manager-interface'
import type { ShipStartRequest, ShipWorkflowState, ShipApprovalRequest, ShipRole, ShipModel, ShipPhase } from '../../../../shared/src/protocol/ship-workflow'
import { parseShipCommand } from '../../../../shared/src/protocol/ship-workflow'
import { evaluateShipGate, hashShipArtifacts, parseShipClaims, parseShipContract, parseShipVerdict, SHIP_BOUNDS } from './gates'
import { readShipState, findShipState, writeShipState, readShipArtifacts, shipDirectory } from './store'
import { buildShipStageSpec, shipRoles } from './prompts'
import { assertShipEvidenceTree, assertShipRepository, shipGitHead, readShipPR, readyShipPR } from './github'

export interface ShipWorkflowDeps {
  manager: ISessionManager; workspaceId: string; workspaceRoot: string
  now?: () => string
  onChange?: (state: ShipWorkflowState) => void
  resolveRoleModels?: (models: ShipStartRequest['models']) => Partial<Record<ShipRole, ShipModel>>
  /** Host adapters are injectable for fixtures; production uses native TaskRunner and GitHub CLI. */
  runner?: Pick<TaskRunner, 'run' | 'resume' | 'stop' | 'getRunState' | 'waitUntilSettled'>
  assertEvidenceTree?: typeof assertShipEvidenceTree; gitHead?: typeof shipGitHead; assertRepository?: typeof assertShipRepository; readPR?: typeof readShipPR; readyPR?: typeof readyShipPR
}
function roleModels(overrides: ShipStartRequest['models']): Partial<Record<ShipRole, ShipModel>> {
  const available = getLlmConnections().flatMap(connection => (connection.models?.length ? connection.models : connection.defaultModel ? [connection.defaultModel] : []).map(model => ({ model: typeof model === 'string' ? model : model.id, llmConnection: connection.slug })))
  const claude = available.filter(item => /claude|opus|sonnet|haiku/i.test(item.model))
  const gpt = available.filter(item => /gpt|codex|astra/i.test(item.model))
  const pilot = claude.find(item => /opus/i.test(item.model)) || claude[0]
  const reviewer = gpt.find(item => /astra/i.test(item.model)) || gpt[0]
  const sol = gpt.find(item => /sol/i.test(item.model)) || reviewer
  const e2e = claude.find(item => /sonnet/i.test(item.model)) || pilot
  const result = { planner: pilot, 'factcheck-code': sol, 'factcheck-external': pilot, omissions: reviewer, builder: pilot, bugs: reviewer, comments: sol, performance: pilot, e2e, feedback: pilot, ...overrides }
  for (const [role, config] of Object.entries(result)) if (!config?.model || !config.llmConnection || !available.some(item => item.model === config.model && item.llmConnection === config.llmConnection)) throw new Error(`Configure an available Claude/GPT model for the Ship ${role} role first.`)
  return result as Partial<Record<ShipRole, ShipModel>>
}
/** Deterministic coordinator over native Tasks, not a second agent runtime. */
export class ShipWorkflowService {
  private runner: ShipWorkflowDeps['runner']
  private queue: Promise<unknown> = Promise.resolve()
  private readonly now: () => string
  constructor(private readonly deps: ShipWorkflowDeps) {
    this.now = deps.now || (() => new Date().toISOString())
    this.runner = deps.runner || new TaskRunner({ host: deps.manager, workspaceId: deps.workspaceId, workspaceRoot: deps.workspaceRoot, defaultMaxParallel: 2 })
  }
  private locked<T>(operation: () => Promise<T>): Promise<T> { const next = this.queue.catch(() => {}).then(operation); this.queue = next; return next }
  private save(state: ShipWorkflowState, event: string): ShipWorkflowState {
    state.updatedAt = this.now(); state.revision++; writeShipState(this.deps.workspaceRoot, state, event); this.deps.onChange?.(structuredClone(state)); return state
  }
  private read(id: string): ShipWorkflowState {
    const state = readShipState(this.deps.workspaceRoot, id)
    if (!state || state.workspaceId !== this.deps.workspaceId) throw new Error('Ship workflow not found in this workspace')
    return state
  }
  getBySession(sessionId: string): ShipWorkflowState | null { return findShipState(this.deps.workspaceRoot, sessionId, true) }
  get(id: string): ShipWorkflowState { return this.read(id) }
  async start(request: ShipStartRequest): Promise<ShipWorkflowState> {
    return this.locked(async () => {
      const existing = findShipState(this.deps.workspaceRoot, request.sessionId); if (existing) return existing
      const source = this.deps.manager.getSessionSnapshot(request.sessionId)
      if (!source || source.workspaceId !== this.deps.workspaceId) throw new Error('Session not found in the active workspace')
      const command = parseShipCommand(`/ship-plan ${request.ticket}`)
      if (command?.kind !== 'plan') throw new Error('Use a Linear issue identifier or canonical issue URL')
      const repositoryPath = this.deps.manager.getSessionWorkingDirectory(request.sessionId)
      if (!repositoryPath) throw new Error('Select and prepare this session’s isolated repository before starting Ship.')
      await (this.deps.assertRepository || assertShipRepository)(repositoryPath)
      const head = await (this.deps.gitHead || shipGitHead)(repositoryPath)
      const id = `ship-${command.ticket.toLowerCase()}-${randomUUID().slice(0, 8)}`
      const now = this.now()
      const state: ShipWorkflowState = { version: 1, id, taskSlug: id, workspaceId: this.deps.workspaceId, sessionId: request.sessionId, orchestratorSessionId: '', projectId: source.projectId, ticket: command.ticket, title: request.title?.trim().slice(0, 250) || command.ticket, repositoryPath, createdAt: now, updatedAt: now, revision: 0, phase: 'plan', status: 'idle', head, planHash: '', rounds: {}, gates: {}, approvals: [], seenHumanCommentIds: [], reasons: [], models: (this.deps.resolveRoleModels || roleModels)(request.models) }
      mkdirSync(join(shipDirectory(this.deps.workspaceRoot, id), 'plan'), { recursive: true })
      const spec = buildShipStageSpec(this.deps.workspaceRoot, state, 'plan')
      const created = await createTaskFromSpec(this.deps.manager, this.deps.workspaceId, this.deps.workspaceRoot, spec, { worktree: 'none' })
      state.orchestratorSessionId = created.orchestratorSessionId
      this.save(state, 'created')
      return this.dispatch(state)
    })
  }
  private async dispatch(state: ShipWorkflowState): Promise<ShipWorkflowState> {
    if (state.job) throw new Error('This Ship step already has a native Task run')
    const phase = state.phase
    if (!shipRoles(phase).length) throw new Error('This step requires a human action, not another agent')
    const round = (state.rounds[phase] || 0) + 1
    const bound = SHIP_BOUNDS[phase as keyof typeof SHIP_BOUNDS]
    const attempts = phase === 'g1' || phase === 'devin' ? round : (state.failures?.[phase] || 0) + 1
    if (bound && attempts > bound) { state.status = 'blocked'; state.reasons = [`${phase}: round limit (${bound}) reached; human decision required.`]; return this.save(state, 'round-bound') }
    await (this.deps.assertRepository || assertShipRepository)(state.repositoryPath)
    state.head = await (this.deps.gitHead || shipGitHead)(state.repositoryPath)
    if (phase !== 'plan') state.planHash = hashShipArtifacts(readShipArtifacts(this.deps.workspaceRoot, state.id))
    if (phase === 'review' || phase === 'e2e') await (this.deps.assertEvidenceTree || assertShipEvidenceTree)(state.repositoryPath)
    const spec: TaskSpec = buildShipStageSpec(this.deps.workspaceRoot, state, phase)
    saveTaskSpec(this.deps.workspaceRoot, spec)
    const runId = `ship-${phase}-r${round}-${randomUUID().slice(0, 8)}`
    state.rounds[phase] = round; state.job = { phase, runId, round, head: state.head, planHash: state.planHash, roles: shipRoles(phase), ...(phase === 'devin' ? { humanCommentIds: state.pr?.humanCommentIds || [] } : {}) }; state.status = 'running'; state.reasons = []
    this.save(state, 'stage-started')
    try {
      this.runner!.run(state.taskSlug, { orchestratorSessionId: state.orchestratorSessionId, runId, verifyOnComplete: false })
      this.observe(state.id, runId)
    } catch {
      state.status = 'blocked'; state.reasons = ['The native Task could not start. No gate has been granted.']; state.job = undefined; this.save(state, 'stage-start-failed')
    }
    return state
  }
  private observe(id: string, runId: string): void {
    // User-started native execution only. No polling or extra background agent is launched here.
    void this.runner!.waitUntilSettled(id, runId).then(() => this.refresh(id)).catch(() => { /* status remains recoverable; refresh surfaces failed runs */ })
  }
  async refresh(id: string): Promise<ShipWorkflowState> { return this.locked(async () => {
    const state = this.read(id)
    try { return await this.refreshUnlocked(state) }
    catch { state.status = 'blocked'; state.reasons = ['Workflow artifacts, attributed outputs or Git state are unavailable. No next gate was granted.']; return this.save(state, 'evidence-unavailable') }
  }) }
  private async refreshUnlocked(state: ShipWorkflowState): Promise<ShipWorkflowState> {
    if (state.job) {
      const job = state.job
      const log = readRunLog(this.deps.workspaceRoot, state.taskSlug, job.runId)
      const terminal = log.findLast(entry => ['run-completed', 'run-failed', 'run-stopped'].includes(entry.kind))
      const memory = this.runner!.getRunState(state.taskSlug, job.runId)
      if (!terminal && !memory) { state.status = 'blocked'; state.reasons = ['Server restarted during this step. Resume the persisted native Task explicitly.']; return this.save(state, 'resume-required') }
      if (!terminal) return state
      if (terminal.kind !== 'run-completed') { state.job = undefined; state.failures = { ...state.failures, [job.phase]: (state.failures?.[job.phase] || 0) + 1 }; state.status = 'blocked'; state.reasons = ['Native Task failed or stopped; no workflow gate was granted.']; return this.save(state, 'stage-failed') }
      state.job = undefined
      let action: { summary: string; handledHumanCommentIds?: string[] } | undefined
      if (job.phase === 'plan' || job.phase === 'build' || job.phase === 'devin') {
        const role = job.roles[0]!
        try {
          const raw = readNodeOutput(this.deps.workspaceRoot, state.taskSlug, job.runId, role)?.text || ''
          const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n/, '').replace(/\n```$/, ''))
          if (value.version !== 1 || value.role !== role || !['COMPLETE', 'BLOCKED', 'FAILED'].includes(value.status) || typeof value.summary !== 'string' || !Array.isArray(value.evidence) || !value.evidence.length || value.evidence.some((entry: unknown) => typeof entry !== 'string' || !entry.trim())) throw new Error('Invalid action result')
          if (value.status !== 'COMPLETE') { state.failures = { ...state.failures, [job.phase]: (state.failures?.[job.phase] || 0) + 1 }; state.status = 'blocked'; state.reasons = [value.summary, ...value.evidence.slice(0, 5)]; return this.save(state, 'action-needs-human') }
          action = { summary: value.summary, handledHumanCommentIds: Array.isArray(value.handledHumanCommentIds) ? value.handledHumanCommentIds.filter((id: unknown) => typeof id === 'string') : [] }
          state.failures = { ...state.failures, [job.phase]: 0 }
          state.lastSummary = { phase: job.phase, text: value.summary }
        } catch { state.status = 'blocked'; state.reasons = ['The worker did not provide a complete structured action result. No next stage was started.']; return this.save(state, 'invalid-action-result') }
      }
      if (job.phase === 'plan') {
        try { const files = readShipArtifacts(this.deps.workspaceRoot, state.id); parseShipClaims(files['claims.jsonl']!); parseShipContract(files['contract.md']!); state.planHash = hashShipArtifacts(files) }
        catch { state.status = 'blocked'; state.reasons = ['Plan artifacts are missing, invalid or incomplete. Repair the six plan files before continuing.']; return this.save(state, 'invalid-plan') }
        state.phase = 'g1'; state.status = 'idle'; this.save(state, 'plan-completed'); return this.dispatch(state)
      }
      if (job.phase === 'g1' || job.phase === 'review' || job.phase === 'e2e') {
        if (job.phase === 'review' || job.phase === 'e2e') await (this.deps.assertEvidenceTree || assertShipEvidenceTree)(state.repositoryPath)
        const files = readShipArtifacts(this.deps.workspaceRoot, state.id)
        const head = await (this.deps.gitHead || shipGitHead)(state.repositoryPath); const planHash = hashShipArtifacts(files)
        const verdicts = job.roles.flatMap(role => {
          // Only output from the actual native node/session can count, never a pilot RPC submission.
          const spawned = log.findLast(entry => entry.kind === 'node-spawned' && entry.nodeId === role)
          const finished = log.findLast(entry => entry.kind === 'node-finished' && entry.nodeId === role)
          if (!spawned || spawned.kind !== 'node-spawned' || !finished || finished.kind !== 'node-finished' || finished.sessionId !== spawned.sessionId || finished.state !== 'done' || spawned.sessionId === state.sessionId || spawned.sessionId === state.orchestratorSessionId) return []
          try { return [parseShipVerdict(readNodeOutput(this.deps.workspaceRoot, state.taskSlug, job.runId, role)?.text || '', role)] } catch { return [] }
        })
        const result = evaluateShipGate({ gate: job.phase, round: job.round, head, planHash, roles: job.roles, verdicts, claims: parseShipClaims(files['claims.jsonl']!), contract: parseShipContract(files['contract.md']!), now: this.now() })
        if (job.head !== head || job.planHash !== planHash) { result.result = 'fail'; result.reasons.push('The Git HEAD or plan changed while the reviewers were working.') }
        state.gates[job.phase] = result; state.head = head; state.planHash = planHash; state.reasons = result.reasons
        if (result.result === 'fail') {
          const bound = SHIP_BOUNDS[job.phase]
          const failures = (state.failures?.[job.phase] || 0) + 1
          state.failures = { ...state.failures, [job.phase]: failures }
          const exhausted = job.phase === 'g1' ? job.round >= bound : failures >= bound
          state.status = exhausted ? 'waiting' : 'blocked'
          if (exhausted) { if (job.phase === 'g1') state.phase = 'discussion'; return this.save(state, 'gate-bound') }
          state.phase = job.phase === 'g1' ? 'plan' : 'build'
          this.save(state, 'gate-repair-required'); return this.dispatch(state)
        }
        if (!result.toFix?.length) state.failures = { ...state.failures, [job.phase]: 0 }; state.status = 'idle'
        if (job.phase === 'g1') { state.phase = 'discussion'; state.status = 'waiting'; return this.save(state, 'plan-awaiting-human-go') }
        if (job.phase === 'review' && result.toFix?.length) { const failures = (state.failures?.review || 0) + 1; state.failures = { ...state.failures, review: failures }; if (failures >= SHIP_BOUNDS.review) { state.status = 'waiting'; state.reasons = ['Comment corrections did not converge within the review bound. Human decision required.']; return this.save(state, 'comment-correction-bound') } state.reasons = result.toFix.map(finding => `${finding.role}/${finding.id}: ${finding.fix} (${finding.evidence})`); state.phase = 'build'; this.save(state, 'comment-corrections-required'); return this.dispatch(state) }
        if (job.phase === 'review') { state.phase = 'e2e'; this.save(state, 'review-passed'); return this.dispatch(state) }
        this.save(state, 'e2e-passed'); return this.markReady(state)
      }
      if (job.phase === 'build') { state.phase = 'review'; state.status = 'idle'; this.save(state, 'build-completed'); return this.dispatch(state) }
      if (job.phase === 'devin') {
        state.status = 'waiting'
        // A human body can contain a requested change even when that review is APPROVED.
        const current = await (this.deps.readPR || readShipPR)(state.repositoryPath)
        state.seenHumanCommentIds = [...new Set([...state.seenHumanCommentIds, ...(action?.handledHumanCommentIds || []).filter(id => job.humanCommentIds?.includes(id))])]
        state.pr = current; state.failures = { ...state.failures, devin: 0 }; this.save(state, 'feedback-round-completed')
      }
    }
    if (state.phase === 'discussion') {
      const hash = hashShipArtifacts(readShipArtifacts(this.deps.workspaceRoot, state.id))
      const head = await (this.deps.gitHead || shipGitHead)(state.repositoryPath)
      if (hash !== state.planHash || head !== state.head) {
        state.planHash = hash; state.head = head; state.approvals = []
        if ((state.rounds.g1 || 0) < SHIP_BOUNDS.g1) { state.phase = 'g1'; state.status = 'blocked'; state.reasons = ['The plan or code changed. Fact-check again before the human go.'] }
        else { state.status = 'waiting'; state.gates.g1 = { ...state.gates.g1!, result: 'fail', reasons: ['Plan or code changed after the last fact-check. Human override of the current artifacts is required.'] }; state.reasons = state.gates.g1.reasons }
        return this.save(state, 'approval-invalidated')
      }
    }
    if (state.phase === 'devin' || state.phase === 'human_review') return this.refreshPR(state)
    return state
  }
  private async markReady(state: ShipWorkflowState): Promise<ShipWorkflowState> {
    await (this.deps.assertEvidenceTree || assertShipEvidenceTree)(state.repositoryPath)
    const head = await (this.deps.gitHead || shipGitHead)(state.repositoryPath)
    const hash = hashShipArtifacts(readShipArtifacts(this.deps.workspaceRoot, state.id))
    if (state.gates.review?.result !== 'pass' || state.gates.e2e?.result !== 'pass' || state.gates.review.head !== head || state.gates.e2e.head !== head || state.gates.review.planHash !== hash || state.gates.e2e.planHash !== hash) { state.phase = 'review'; state.status = 'blocked'; state.reasons = ['Review and E2E must both pass at the exact current HEAD and plan.']; return this.save(state, 'stale-ready-gates') }
    try {
      const pr = await (this.deps.readPR || readShipPR)(state.repositoryPath)
      if (pr.head !== head || pr.state !== 'OPEN') throw new Error('PR HEAD mismatch')
      await (this.deps.readyPR || readyShipPR)(state.repositoryPath, pr.number, head)
      state.pr = { ...pr, draft: false }; state.phase = 'devin'; state.status = 'waiting'; state.reasons = ['Waiting for bot feedback and required CI. Send /ship to handle one feedback round.']
      return this.save(state, 'pr-ready')
    } catch { state.status = 'blocked'; state.reasons = ['Unable to mark this exact PR head ready. Verify GitHub access and the draft PR, then continue.']; return this.save(state, 'ready-blocked') }
  }
  private async refreshPR(state: ShipWorkflowState): Promise<ShipWorkflowState> {
    try {
      const pr = await (this.deps.readPR || readShipPR)(state.repositoryPath)
      if (state.pr && state.pr.number !== pr.number) throw new Error('This run is already bound to another PR')
      state.pr = pr
      if (pr.state !== 'OPEN') { state.phase = 'done'; state.status = 'done'; state.reasons = [pr.state === 'MERGED' ? 'Observed merged on GitHub. Craft did not merge it.' : 'PR closed without merge.']; return this.save(state, 'pr-closed') }
      const unseen = pr.humanCommentIds.filter(id => !state.seenHumanCommentIds.includes(id))
      const blocked = pr.botOpenThreads || pr.humanOpenThreads || unseen.length || pr.requiredCI !== 'green' || pr.conflicting
      if (blocked || !pr.botReviewedHead) {
        state.phase = 'devin'; state.status = 'waiting'; state.reasons = [pr.botOpenThreads ? `${pr.botOpenThreads} open bot threads` : '', pr.humanOpenThreads ? `${pr.humanOpenThreads} human threads remain for the owner` : '', unseen.length ? `${unseen.length} human review/comment bodies to read` : '', pr.requiredCI !== 'green' ? `Required CI: ${pr.requiredCI}` : '', pr.conflicting ? 'Base conflicts or mergeability unknown' : '', !pr.botReviewedHead ? 'Bot review of this head not observed; waiting for its check or the documented 45-minute grace' : ''].filter(Boolean)
      } else { state.phase = 'human_review'; state.status = 'waiting'; state.reasons = [pr.humanApprovedHead ? 'Human approved this head. Ready for the owner to merge manually.' : 'Waiting for a human approval of this exact head.'] }
      return this.save(state, 'github-refreshed')
    } catch { state.status = 'blocked'; state.reasons = ['GitHub state unavailable or incomplete. No CI or review approval was inferred.']; return this.save(state, 'github-unavailable') }
  }
  async advance(id: string): Promise<ShipWorkflowState> { return this.locked(async () => {
    let state = await this.refreshUnlocked(this.read(id))
    if (state.phase === 'done') return state
    if (state.job) {
      if (this.runner!.getRunState(state.taskSlug, state.job.runId)) return state
      this.runner!.resume(state.taskSlug, state.job.runId, { verifyOnComplete: false }); this.observe(state.id, state.job.runId); state.status = 'running'; state.reasons = []; return this.save(state, 'native-run-resumed')
    }
    if (state.phase === 'discussion') {
      const hash = hashShipArtifacts(readShipArtifacts(this.deps.workspaceRoot, state.id))
      const approval = state.approvals.findLast(approval => ['go', 'override-g1'].includes(approval.decision) && approval.planHash === hash && approval.head === state.head)
      if (!approval) { state.status = 'waiting'; state.reasons = ['Approve this exact plan using the native approval button. Conversation text cannot approve it.']; return this.save(state, 'human-go-required') }
      state.phase = 'build'
    }
    if (state.phase === 'human_review') return state
    if (state.phase === 'e2e' && state.gates.e2e?.result === 'pass') return this.markReady(state)
    // A changed code head invalidates prior review before another E2E.
    if (state.phase === 'e2e' && state.gates.review?.head !== await (this.deps.gitHead || shipGitHead)(state.repositoryPath)) state.phase = 'review'
    return this.dispatch(state)
  }) }
  /** Only the host-confirmed UI channel may call this method; never expose it as an agent tool. */
  async approve(id: string, request: ShipApprovalRequest, humanActor: string): Promise<ShipWorkflowState> { return this.locked(async () => {
    const state = this.read(id)
    if (!humanActor || state.revision !== request.revision || state.phase !== 'discussion' || state.job) throw new Error('Approval is stale or this workflow is not waiting for a human plan decision')
    const hash = hashShipArtifacts(readShipArtifacts(this.deps.workspaceRoot, state.id)); const head = await (this.deps.gitHead || shipGitHead)(state.repositoryPath)
    if (hash !== state.planHash || head !== state.head) throw new Error('Plan changed after fact-check. Run G1 again before approving.')
    const gate = state.gates.g1
    const pass = gate?.result === 'pass' && gate.planHash === hash && gate.head === head
    const override = request.decision === 'override-g1' && gate?.result === 'fail' && gate.round >= SHIP_BOUNDS.g1
    if (!(request.decision === 'go' && pass) && !override) throw new Error('G1 must pass, or a human must explicitly override it after round two')
    state.approvals.push({ decision: request.decision, at: this.now(), revision: state.revision, planHash: hash, head, by: humanActor })
    state.status = 'idle'; state.reasons = []; return this.save(state, 'human-plan-approved')
  }) }
  async stop(id: string): Promise<ShipWorkflowState> { return this.locked(async () => {
    const state = this.read(id)
    if (state.job) await this.runner!.stop(state.taskSlug, state.job.runId)
    state.job = undefined; state.status = 'waiting'; state.reasons = ['Stopped by the owner. No workflow gate was granted.']; return this.save(state, 'owner-stopped')
  }) }
}
