import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendRunLog, saveTaskSpec, writeNodeOutput } from '@craft-agent/shared/tasks'
import { TaskRunner, type ConductorSessionHost } from '../../tasks/TaskRunner'

test('persisted native completed nodes resume without rerun or a pilot model verdict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'craft-ship-native-resume-'))
  try {
    const slug = 'ship-fixture', runId = 'ship-review-r1-fixture', t = '2026-10-27T00:00:00Z'
    saveTaskSpec(root, { id: slug, title: 'Fixture native stage', goal: 'Fixture only', runner: 'conduct', nodes: [{ id: 'bugs', kind: 'session', prompt: 'Fixture reviewer' }], max_iterations: 0, max_parallel: 2 })
    appendRunLog(root, slug, runId, { kind: 'run-started', t, taskId: slug, runId, orchestratorSessionId: 'parent' })
    appendRunLog(root, slug, runId, { kind: 'node-spawned', t, nodeId: 'bugs', sessionId: 'reviewer-original' })
    appendRunLog(root, slug, runId, { kind: 'node-finished', t, nodeId: 'bugs', sessionId: 'reviewer-original', state: 'done' })
    writeNodeOutput(root, slug, runId, 'bugs', { text: '{"fixture":"attributed saved verdict"}' })
    let created = 0, sent = 0
    const host: ConductorSessionHost = { createSession: async () => { created++; return { id: 'should-not-run' } }, sendMessage: async () => { sent++ }, setSessionStatus: async () => {}, setKanbanColumn: async () => {}, setTaskNodeCount: async () => {}, cancelProcessing: async () => {}, onSessionComplete: () => () => {}, getSessionWorkingDirectory: () => '/fixture' }
    const runner = new TaskRunner({ host, workspaceId: 'fixture', workspaceRoot: root })
    runner.resume(slug, runId, { verifyOnComplete: false })
    expect(runner.getRunState(slug, runId)?.status).toBe('completed')
    expect((await runner.waitUntilSettled(slug, runId)).nodes[0]?.sessionId).toBe('reviewer-original')
    expect(created).toBe(0); expect(sent).toBe(0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Ship children keep the exact owner cwd and opt out of extra worktrees; ordinary Tasks keep defaults', async () => {
  const root = mkdtempSync(join(tmpdir(), 'craft-ship-native-cwd-'))
  const created: Array<{ cwd?: string; worktree?: string }> = []
  const host: ConductorSessionHost = { createSession: async (_workspace, options) => { created.push({ cwd: options.workingDirectory, worktree: options.worktree }); return { id: `child-${created.length}` } }, sendMessage: async () => {}, setSessionStatus: async () => {}, setKanbanColumn: async () => {}, setTaskNodeCount: async () => {}, cancelProcessing: async () => {}, onSessionComplete: () => () => {}, getSessionWorkingDirectory: () => '/different-parent-default' }
  const runner = new TaskRunner({ host, workspaceId: 'fixture', workspaceRoot: root })
  try {
    mkdirSync(join(root, 'tasks/ship-owned/ship'), { recursive: true }); writeFileSync(join(root, 'tasks/ship-owned/ship/state.json'), JSON.stringify({ version: 1, id: 'ship-owned' }))
    for (const slug of ['ship-owned', 'ordinary', 'ship-ordinary']) {
      saveTaskSpec(root, { id: slug, title: slug, goal: 'Fixture only', runner: 'conduct', cwd: '/owner-worktree', nodes: [{ id: 'bugs', kind: 'session', prompt: 'Fixture only' }] })
      runner.run(slug, { runId: 'fixture', orchestratorSessionId: `parent-${slug}`, verifyOnComplete: false })
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(created[0]).toEqual({ cwd: '/owner-worktree', worktree: 'none' })
    expect(created[1]).toEqual({ cwd: '/different-parent-default', worktree: undefined })
    expect(created[2]).toEqual({ cwd: '/different-parent-default', worktree: undefined })
  } finally { await runner.stop('ship-owned', 'fixture'); await runner.stop('ordinary', 'fixture'); await runner.stop('ship-ordinary', 'fixture'); rmSync(root, { recursive: true, force: true }) }
})
