import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeAgent, claudeThinkingKey } from '../claude-agent'
import { ClaudeEventAdapter } from '../backend/claude/event-adapter'
import { PendingSteers } from '../backend/claude/pending-steers'
import { createPushableInputStream } from '../backend/claude/persistent-input'
import { AbortReason } from '../core'

const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const thinking = { thinking: { type: 'adaptive' as const }, effort: 'high' as const }
const result = () => ({ type: 'result', subtype: 'success', usage: { input_tokens: 30, output_tokens: 7 }, total_cost_usd: 0.1 })
const text = (value: string) => ({ type: 'assistant', message: { id: value, content: [{ type: 'text', text: value }] }, parent_tool_use_id: null })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'claude-native-')); roots.push(root)
  const sdk = createPushableInputStream<any>()
  let promptCount = 0
  const input = createPushableInputStream<any>()
  const agent = Object.assign(Object.create(ClaudeAgent.prototype), {
    config: { workspace: { rootPath: root }, session: { id: 'test' } },
    _currentTurnUserMessage: null,
    persistentUserMessage: '/ship-plan SAP-4410',
    currentQuery: { interrupt: async () => {}, applyFlagSettings: async () => {}, setMaxThinkingTokens: async () => {} },
    persistentIterator: sdk.stream[Symbol.asyncIterator](),
    persistentInput: { ...input, push: (prompt: any) => { promptCount++; input.push(prompt) } },
    persistentThinkingKey: claudeThinkingKey(thinking),
    persistentAbortController: new AbortController(),
    keepBackgroundTasksAlive: true,
    pendingBackgroundTurns: [], pendingPermissions: new Map(), pendingSteers: new PendingSteers(),
    eventAdapter: new ClaudeEventAdapter({ mapSDKError: async () => ({ type: 'error', message: 'mock error' }) } as any),
    usageTracker: { getContextWindow: () => 200000 },
    prerequisiteManager: { resetReadState: () => {} }, sourceManager: { resetSeenSources: () => {} },
    detectInactiveSourceToolError: () => null,
    debug: () => {},
  }) as any
  agent.startPersistentConsumer()
  return { agent, sdk, prompts: () => promptCount, send: async (message: any) => { sdk.push(message); await tick() } }
}
async function collect(source: AsyncIterable<any>) { const events = []; for await (const event of source) events.push(event); return events }

describe('native SDK continuations', () => {
  it('delivers tools and the final plan after an initial result, without another SDK prompt', async () => {
    const f = fixture()
    const foreground = createPushableInputStream<any>()
    f.agent.activeTurnChannel = foreground; f.agent.activeTurnState = { aborted: false }
    const initial = collect(foreground.stream)
    await f.send(text('waiting')); await f.send(result()); await initial
    await f.send({ type: 'system', subtype: 'task_notification', task_id: 'review', status: 'completed' })
    await f.send({ type: 'assistant', message: { id: 'tool', content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/plan.md' } }] } })
    await f.send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'plan' }] } })
    await f.send(text('PLAN_COMPLETE')); await f.send(result())
    expect(f.agent.canReleaseIdleRuntime()).toBe(false)
    const events = await collect(f.agent.resumeBackgroundTurn())
    expect(events.filter(e => e.type === 'tool_start')).toHaveLength(1)
    expect(events.filter(e => e.type === 'tool_result')).toHaveLength(1)
    expect(events.filter(e => e.type === 'text_complete').map(e => e.text)).toEqual(['PLAN_COMPLETE'])
    expect(events.filter(e => e.type === 'complete')).toHaveLength(1)
    expect(f.prompts()).toBe(0)
    expect(f.agent.canReleaseIdleRuntime()).toBe(true)
    f.agent.teardownPersistentQuery()
  })

  it('buffers several result-delimited continuations in order, including natural query exit', async () => {
    const f = fixture()
    await f.send(text('one')); await f.send(result()); await f.send(text('two')); await f.send(result())
    f.sdk.end(); await tick()
    const first = await collect(f.agent.resumeBackgroundTurn())
    expect(f.agent.canReleaseIdleRuntime()).toBe(false)
    const second = await collect(f.agent.resumeBackgroundTurn())
    expect([...first, ...second].filter(e => e.type === 'text_complete').map(e => e.text)).toEqual(['one', 'two'])
    expect([...first, ...second].filter(e => e.type === 'complete')).toHaveLength(2)
    expect(f.prompts()).toBe(0)
  })

  it('cannot overwrite native output with an owner prompt, even during async thinking changes', async () => {
    const f = fixture()
    let release!: () => void
    f.agent.currentQuery.applyFlagSettings = () => new Promise<void>(resolve => { release = resolve })
    const start = f.agent.beginPersistentTurn({ type: 'user', message: { role: 'user', content: 'next' } }, {}, { thinking: { type: 'adaptive' }, effort: 'low' })
    await tick(); await f.send(text('native')); await f.send(result()); release()
    await expect(start).rejects.toThrow()
    expect(f.prompts()).toBe(0)
    const native = await collect(f.agent.drainBackgroundTurn(true))
    expect(native.find(e => e.type === 'complete')?.continuing).toBe(true)
    const next = await f.agent.beginPersistentTurn({ type: 'user', message: { role: 'user', content: 'next' } }, {}, { thinking: { type: 'adaptive' }, effort: 'low' })
    const reading = collect(next)
    await f.send(text('owner reply')); await f.send(result()); await reading
    expect(f.prompts()).toBe(1)
    f.agent.teardownPersistentQuery()
  })

  it('discards buffered and stopped tails, but can accept later legitimate background work', async () => {
    const f = fixture()
    await f.send(text('discard'))
    expect(f.agent.stopTurn()).toBe(true)
    await f.send(text('old tail')); await f.send(result())
    expect(f.agent.hasPendingBackgroundTurn()).toBe(false)
    await f.send(text('new task')); await f.send(result())
    const events = await collect(f.agent.resumeBackgroundTurn())
    expect(events.filter(e => e.type === 'text_complete').map(e => e.text)).toEqual(['new task'])
    f.agent.teardownPersistentQuery()
  })

  it('hard abort invalidates a buffered continuation and prevents trailing resurrection', async () => {
    const f = fixture()
    await f.send(text('discard')); await f.send(result())
    f.agent.forceAbort(AbortReason.UserStop)
    await f.send(text('late')); await f.send(result())
    expect(f.agent.hasPendingBackgroundTurn()).toBe(false)
    expect(await collect(f.agent.resumeBackgroundTurn())).toEqual([])
    f.agent.teardownPersistentQuery()
  })

  it('retains adapter recovery observations when the SDK stream throws', async () => {
    const f = fixture()
    const outcome = { receivedComplete: false, receivedAssistantContent: false, suppressedSessionExpiredError: false, suppressedBranchCutoffError: false }
    async function* broken() { yield text('already delivered'); throw new Error('broken stream') }
    await expect(collect(f.agent.drainSdkTurn(broken(), null, 'real request', join(roots.at(-1)!, 'session'), false, false, false, false, outcome))).rejects.toThrow('broken stream')
    expect(outcome.receivedAssistantContent).toBe(true)
    f.agent.teardownPersistentQuery()
  })
  it('forwards native and owner usage through PendingSteers rather than replacing the first result', async () => {
    const f = fixture()
    await f.send(text('native')); await f.send(result())
    async function* ownerTurn() {
      yield* f.agent.drainBackgroundTurn(true)
      yield { type: 'complete', usage: { inputTokens: 9, outputTokens: 11 } }
    }
    const events = await collect(f.agent.pendingSteers.runTurn(ownerTurn()))
    expect(events.filter(e => e.type === 'complete').map(e => [e.continuing ?? false, e.usage.outputTokens])).toEqual([[true, 7], [false, 11]])
    f.agent.teardownPersistentQuery()
  })

  it('hands source activation to the latest owner request before any new SDK input', async () => {
    const f = fixture()
    await f.send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'missing tool', is_error: true }] } })
    f.agent.detectInactiveSourceToolError = () => ({ sourceSlug: 'linear', toolName: 'linear' })
    f.agent.onSourceActivationRequest = async () => true
    const preparing = f.agent.beginPersistentTurnAfterBackground({ type: 'user', message: { role: 'user', content: 'latest request' } }, {}, thinking, 'latest request')
    const events = []
    let terminal: any
    while (true) { const step = await preparing.next(); if (step.done) { terminal = step.value; break }; events.push(step.value) }
    expect(terminal).toBeNull()
    expect(events.find(e => e.type === 'source_activated')?.originalMessage).toBe('latest request')
    expect(f.prompts()).toBe(0)
    f.agent.teardownPersistentQuery()
  })

  it('retains autonomous compaction and a bare failure result, without assistant content', async () => {
    const f = fixture()
    await f.send({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', post_tokens: 1234 } })
    await f.send({ ...result(), subtype: 'error_during_execution', errors: ['provider failed'] })
    const events = await collect(f.agent.resumeBackgroundTurn())
    expect(events.some(e => e.type === 'info' && e.message === 'Compacted Conversation')).toBe(true)
    expect(events.some(e => e.type === 'error' && e.message === 'provider failed')).toBe(true)
    expect(events.filter(e => e.type === 'complete')).toHaveLength(1)
    await f.send({ ...result(), subtype: 'error_during_execution', errors: ['bare failure'] })
    expect((await collect(f.agent.resumeBackgroundTurn())).some(e => e.type === 'error' && e.message === 'bare failure')).toBe(true)
    f.agent.teardownPersistentQuery()
  })

  it('reports a truncated later continuation as failed after a prior Stop', async () => {
    const f = fixture()
    await f.send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'first' } } })
    const running = f.agent.resumeBackgroundTurn()
    await running.next()
    f.agent.stopTurn()
    await expect(collect(running)).rejects.toThrow('aborted')
    await f.send(result())
    await f.send(text('later')); f.sdk.end(); await tick()
    await expect(collect(f.agent.resumeBackgroundTurn())).rejects.toThrow('before its result')
  })

  it('does not reserve a native turn for an isolated idle-clear status', async () => {
    const f = fixture()
    await f.send({ type: 'system', subtype: 'status', status: null })
    expect(f.agent.hasPendingBackgroundTurn()).toBe(false)
    expect(f.agent.canReleaseIdleRuntime()).toBe(true)
    f.agent.teardownPersistentQuery()
  })

})
