import { expect, mock, test } from 'bun:test'
mock.module('@craft-agent/shared/config', () => ({ getWorkspaceByNameOrId: (id: string) => ({ id, rootPath: `/fixture/${id}` }) }))
const { registerShipUsageHandlers } = await import('./ship-usage')
const handlers = new Map<string, (...args: any[]) => unknown>()
const server = { handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler) }
const manager = { waitForInit: async () => {}, getSessionSnapshot: (id: string) => id === 'chat' ? { workspaceId: 'A' } : null, getSessionWorkingDirectory: () => undefined }
registerShipUsageHandlers(server as any, { sessionManager: manager } as any)
test('usage reads require the owning workspace and preserve unknown coverage for an empty chat', async () => {
  const get = handlers.get('shipUsage:get')!
  await expect(get({ workspaceId: 'B' }, 'chat')).rejects.toThrow('workspace')
  await expect(get({ workspaceId: null }, 'chat')).rejects.toThrow('workspace')
  await expect(get({ workspaceId: 'A' }, 'missing')).rejects.toThrow('Session not found')
  expect(await get({ workspaceId: 'A' }, 'chat')).toEqual({ coverage: 'codex-helper-only', accountAttribution: 'unknown', attempts: [], truncated: false })
})
