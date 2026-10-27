import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSession, pickSessionFields, saveSession } from '@craft-agent/shared/sessions'
import { createManagedSession } from './SessionManager'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
test('historical profile data round-trips without losing messages, project, SDK identity or owned checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-agent-header-'))
  roots.push(root)
  const header = { id: 'legacy-fixture', workspaceRootPath: root, createdAt: 1, lastUsedAt: 2, codingMode: true, projectId: 'retained-project', sdkSessionId: 'retained-sdk', sdkCwd: '/fixture/worktree', worktree: { repositoryPath: '/fixture/repo', owned: { version: 1, ownerId: 'ws/legacy-fixture', path: '/fixture/worktree', branch: 'old/branch' } }, messages: [{ id: 'message', type: 'user', content: 'Retained original message', timestamp: 1 }], tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, contextTokens: 3, costUsd: 0 } }
  await saveSession(header as never)
  const loaded = loadSession(root, header.id)!
  const managed = createManagedSession(loaded as never, { id: 'ws', name: 'Fixture', rootPath: root, createdAt: 1 } as never)
  const fields = pickSessionFields(managed)
  await saveSession({ ...loaded, ...fields, messages: loaded.messages } as never)
  const roundTrip = loadSession(root, header.id)!
  expect(roundTrip.messages).toEqual(loaded.messages)
  expect(roundTrip.projectId).toBe(header.projectId)
  expect(roundTrip.sdkSessionId).toBe(header.sdkSessionId)
  expect(roundTrip.sdkCwd).toBe(header.sdkCwd)
  expect(roundTrip.worktree).toEqual(loaded.worktree)
  expect(roundTrip.codingMode).toBe(true) // compatibility data only, never a tool/profile selector
})
