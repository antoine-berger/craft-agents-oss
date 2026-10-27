import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleMarkAttention, handleRequestUserInput, type AttentionToolContext } from '../../../session-tools-core/src/handlers/attention'
import { messageToStored, storedToMessage, type Message } from '@craft-agent/core/types'
import type { SessionEvent } from '@craft-agent/shared/protocol'
import { AbortReason } from '@craft-agent/shared/agent'
import { SessionAttentionService } from '../services/session-attention/service'
import { SessionManager, createManagedSession } from './SessionManager'

/** Real tool handler → production host callback → real processEvent; no model or backend. */
async function handoff(toolName: string, kind: 'question' | 'plan' | 'error' = 'question', replay = false) {
  const root = mkdtempSync(join(tmpdir(), 'craft-attention-handoff-'))
  const events: SessionEvent[] = []
  const order: string[] = []
  const managed = createManagedSession({ id: 'attention-fixture' }, {
    id: 'workspace', name: 'Fixture', slug: 'fixture', rootPath: root, createdAt: 1,
  }, { messagesLoaded: true })
  const manager = Object.create(SessionManager.prototype) as any
  manager.sessions = new Map([[managed.id, managed]])
  manager.sessionActivityListeners = new Map()
  manager.sendEvent = (event: SessionEvent) => { events.push(event); order.push(event.type) }
  manager.persistSession = () => { order.push('persist') }
  manager.decisionFeatureActive = () => false
  manager.monotonic = () => Date.now()
  manager.getSessionSnapshot = () => ({ id: managed.id, workspaceId: 'workspace', isProcessing: managed.isProcessing })
  manager.getBrowserPaneManagerForSession = () => ({
    clearVisualsForSession: async (id: string) => { expect(id).toBe(managed.id); order.push('release-overlay') },
    unbindAllForSession: (id: string) => { expect(id).toBe(managed.id); order.push('release-binding') },
  })
  const service = new SessionAttentionService({ manager, workspaceRoot: () => root, push: () => {} })
  const tool: Message = { id: 'tool', role: 'tool' as const, content: '', timestamp: 2, toolUseId: 'request-tool', toolName, turnId: 'original-turn', toolStatus: 'executing' as const }
  const unrelated: Message = { ...tool, id: 'unrelated', toolUseId: 'unrelated-tool', toolName: 'mcp__other__request_user_input' }
  managed.messages.push(tool, unrelated)
  managed.isProcessing = true
  managed.agent = {
    interruptForHandoff: (reason: unknown) => {
      order.push('interrupt')
      expect(reason).toBe(AbortReason.PlanSubmitted)
      expect(service.snapshot('workspace').sessions[managed.id]?.status).toBe('needs-human')
      // Mirrors the teardown's treatment of tools whose result never arrived.
      for (const message of managed.messages) if (message.toolStatus === 'executing') {
        message.toolStatus = 'error'; message.isError = true
      }
    },
    takePendingSteers: () => [],
  } as never
  const ctx = { markAttention: (request: Parameters<NonNullable<AttentionToolContext['markAttention']>>[0]) => manager.markSessionAttention(managed, request, service) } as AttentionToolContext
  try {
    const result = toolName.endsWith('request_user_input')
      ? await handleRequestUserInput(ctx, { question: 'Which target?', choices: ['Preview', 'Production'] })
      : await handleMarkAttention(ctx, { kind, title: 'Review the plan', detail: 'Approve the proposed work.' })
    expect(result.isError).not.toBe(true)
    expect(tool.toolStatus).toBe('completed')
    expect((tool as any).isError).toBe(false)
    expect(unrelated.toolStatus).toBe('error')
    expect(events.filter(e => e.type === 'tool_result')).toEqual([expect.objectContaining({ type: 'tool_result', toolUseId: 'request-tool', toolName, isError: false })])
    expect(order.indexOf('tool_result')).toBeLessThan(order.indexOf('interrupt'))
    expect(order.indexOf('release-overlay')).toBeGreaterThan(order.indexOf('interrupt'))
    expect(order.indexOf('release-binding')).toBeLessThan(order.indexOf('complete'))
    expect(events.at(-1)?.type).toBe('complete')
    expect(managed.isProcessing).toBe(false)
    expect(service.snapshot('workspace').sessions[managed.id]?.reasons[0]?.kind).toBe(kind)
    expect(service.snapshot('workspace').sessions[managed.id]?.status).toBe('needs-human')
    if (replay) {
      const cancellation = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
      const lateResult = { type: 'tool_result' as const, toolUseId: tool.toolUseId!, toolName, turnId: tool.turnId, isError: true, result: cancellation }
      const authoritativeResult = tool.toolResult
      const successes = events.filter(event => event.type === 'tool_result').length
      await manager.processEvent(managed, lateResult)
      expect(tool.toolStatus).toBe('completed')
      expect(tool.isError).toBe(false)
      expect(tool.toolResult).toBe(authoritativeResult)
      expect(events.filter(event => event.type === 'tool_result')).toHaveLength(successes)

      // Real persisted Message mapping + disk round trip, then no runtime agent. An SDK resume may
      // replay the previous turn's cancellation while a later user turn is already processing.
      const file = join(root, 'message.jsonl')
      writeFileSync(file, JSON.stringify(messageToStored(tool)) + '\n')
      const restore = () => storedToMessage(JSON.parse(readFileSync(file, 'utf8')))
      managed.messages = [restore()]
      managed.agent = null
      managed.isProcessing = true
      await manager.processEvent(managed, lateResult)
      expect(managed.messages[0]?.toolStatus).toBe('completed')
      expect(managed.messages[0]?.isError).toBe(false)
      await manager.processEvent(managed, { ...lateResult, turnId: undefined })
      expect(managed.messages[0]?.toolStatus).toBe('completed')
      expect(service.snapshot('workspace').sessions[managed.id]?.status).toBe('needs-human')

      // Negative controls: genuine failure, explicit different turn/parent or source all remain errors.
      for (const override of [
        { result: 'Backend authentication failed' },
        { turnId: 'different-turn' },
        { parentToolUseId: 'different-parent' },
        { toolName: 'mcp__other__request_user_input' },
      ]) {
        managed.messages = [restore()]
        await manager.processEvent(managed, { ...lateResult, ...override })
        expect(managed.messages[0]?.toolStatus).toBe('error')
        expect(managed.messages[0]?.isError).toBe(true)
      }
      const otherCall: Message = { ...restore(), id: 'next-call', toolUseId: 'new-tool-id', toolStatus: 'executing', toolResult: undefined, isError: undefined }
      managed.messages = [restore(), otherCall]
      await manager.processEvent(managed, { ...lateResult, toolUseId: 'new-tool-id' })
      expect(managed.messages[0]?.toolStatus).toBe('completed')
      expect(otherCall.toolStatus).toBe('error')
      const otherSource: Message = { ...restore(), toolName: 'mcp__other__request_user_input' }
      managed.messages = [otherSource]
      await manager.processEvent(managed, { ...lateResult, toolName: otherSource.toolName })
      expect(otherSource.toolStatus).toBe('error')
    }
  } finally { service.dispose(); rmSync(root, { recursive: true, force: true }) }
}
describe('attention tool handoff completion', () => {
  it('preserves a confirmed question across trailing SDK cancellation, persisted resume and unrelated real failures', () => handoff('mcp__session__request_user_input', 'question', true))
  it('completes the Pi canonical request_user_input before interruption', () => handoff('request_user_input'))
  it('completes mark_attention plans before releasing browser ownership', () => handoff('mcp__session__mark_attention', 'plan', true))
  it('completes canonical mark_attention errors without falsely failing its own tool', () => handoff('mark_attention', 'error', true))
})
