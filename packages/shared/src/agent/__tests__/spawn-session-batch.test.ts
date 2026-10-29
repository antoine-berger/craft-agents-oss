import { expect, it } from 'bun:test'
import { TestAgent, createMockBackendConfig } from './test-utils'
import { SpawnSessionSchema, getToolDefsAsJsonSchema } from '@craft-agent/session-tools-core'
import { createSpawnSessionTool } from '../spawn-session-tool'
class SpawnAgent extends TestAgent { invoke(input: Record<string, unknown>) { return this.preExecuteSpawnSession(input) } }
it('starts every independent child before waiting for a sibling and returns partial results in input order', async () => {
  const agent = new SpawnAgent(createMockBackendConfig())
  const starts: any[] = []; let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  agent.onSpawnSession = async request => {
    starts.push(request)
    if (request.name === 'slow') await gate
    if (request.name === 'failed') throw Object.assign(Error('first-send failure'), { sessionId: 'already-created' })
    return { sessionId: request.name!, name: request.name!, status: 'started' }
  }
  const repository = { kind: 'github', nameWithOwner: 'owner/repo', start: { kind: 'branch', branch: 'parent', copy: true } }
  const result = agent.invoke({ sessions: [
    { prompt: '/ship-plan ISSUE-1', name: 'slow', projectId: 'project', repository, thinkingLevel: 'high' },
    { prompt: '/ship-plan ISSUE-2', name: 'fast', projectId: null, workingDirectory: '~/code' },
    { prompt: '/ship-plan ISSUE-3', name: 'failed' },
  ] })
  expect(starts).toHaveLength(3)
  expect(starts[0]).toMatchObject({ prompt: '/ship-plan ISSUE-1', projectId: 'project', repository, thinkingLevel: 'high' })
  expect(starts[1].workingDirectory.startsWith('/')).toBe(true)
  release()
  const response = await result as any
  expect(response.results.map((r: any) => r.status)).toEqual(['started', 'started', 'error'])
  expect(response.results[2].sessionId).toBe('already-created')
})
it('validates batch shape and rejects ambiguous overrides before creating anything', async () => {
  const agent = new SpawnAgent(createMockBackendConfig()); let calls = 0
  agent.onSpawnSession = async () => { calls++; return { sessionId: 'x', name: 'x', status: 'started' } }
  await expect(agent.invoke({ prompt: 'single', sessions: [{ prompt: 'batch' }] })).rejects.toThrow('sessions alone')
  await expect(agent.invoke({ sessions: [] })).rejects.toThrow('Invalid')
  await expect(agent.invoke({ sessions: [{ prompt: 'valid' }, { projectId: 'missing prompt' }] })).rejects.toThrow('Invalid')
  expect(calls).toBe(0)
})
it('advertises the same batch and repository fields for Claude SDK and MCP/Pi', () => {
  const native = createSpawnSessionTool({ sessionId: 'fixture', getSpawnSessionFn: () => undefined }) as any
  expect(native.inputSchema.sessions).toBe(SpawnSessionSchema.shape.sessions)
  const definition = getToolDefsAsJsonSchema().find((tool: any) => tool.name === 'spawn_session') as any
  expect(definition.inputSchema.properties.sessions).toBeDefined()
  expect(definition.inputSchema.properties.repository).toBeDefined()
})
