import { expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionAttentionService } from './service'
import type { ISessionManager } from '../../handlers/session-manager-interface'

it('removes only dead interactive-question attention after restart and retains ordinary owner handoffs', () => {
  const root = mkdtempSync(join(tmpdir(), 'question-attention-restart-'))
  const manager = { getSessionSnapshot: () => ({ id: 's', workspaceId: 'w' }), getPendingQuestion: () => ({ requestId: 'live' }) } as unknown as ISessionManager
  const first = new SessionAttentionService({ manager, workspaceRoot: () => root, push: () => {} })
  try {
    first.upsertReason('s', { id: 'interactive-question', source: 'agent', kind: 'question', title: 'Live form', createdAt: 1, action: { type: 'session' } })
    first.upsertReason('s', { id: 'normal-handoff', source: 'agent', kind: 'plan', title: 'Review plan', createdAt: 1, action: { type: 'session' } })
    first.dispose()
    const restarted = new SessionAttentionService({ manager: { ...manager, getPendingQuestion: () => null }, workspaceRoot: () => root, push: () => {} })
    try {
      expect(restarted.snapshot('w').sessions.s?.reasons.map(reason => reason.id)).toEqual(['normal-handoff'])
    } finally { restarted.dispose() }
  } finally { first.dispose(); rmSync(root, { recursive: true, force: true }) }
})
