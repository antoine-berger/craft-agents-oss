import { describe, expect, it } from 'bun:test'
import { registerSessionsHandlers } from './sessions'
import { SessionQuestions } from '../../sessions/session-questions'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'

const service = new SessionQuestions(() => {})
const handlers = new Map<string, (...args: any[]) => unknown>()
const manager = {
  getSessionSnapshot: () => ({ workspaceId: 'one' }),
  getPendingQuestion: (sid: string) => service.get(sid),
  respondToQuestion: (sid: string, requestId: string, response: unknown) => service.answer(sid, requestId, response),
}
registerSessionsHandlers({ handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler) } as any,
  { sessionManager: manager, platform: { logger: { info() {}, error() {} } }, windowManager: { getWorkspaceForWindow: () => 'two' } } as any)
const command = handlers.get(RPC_CHANNELS.sessions.COMMAND)!
const questions = [{ question: 'Choose a target', options: [{ label: 'Preview' }, { label: 'Production' }] }]

describe('question session commands', () => {
  it('scopes reads and responses to the authenticated workspace, including desktop windows', async () => {
    const pending = service.ask('chat', questions)
    const request = service.get('chat')!
    await expect(command({ workspaceId: 'two' }, 'chat', { type: 'getPendingQuestion' })).rejects.toThrow('workspace')
    await expect(command({ webContentsId: 42 }, 'chat', { type: 'respondToQuestion', requestId: request.requestId, response: { cancelled: true, answers: [] } })).rejects.toThrow('workspace')
    expect(await command({ workspaceId: 'one' }, 'chat', { type: 'getPendingQuestion' })).toMatchObject({ requestId: request.requestId })
    expect(await command({ workspaceId: 'one' }, 'chat', { type: 'respondToQuestion', requestId: request.requestId, response: { answers: [{ selected: ['Preview'] }] } })).toBe(true)
    expect((await pending).answers[0]?.selected).toEqual(['Preview'])
    await expect(command({ workspaceId: 'one' }, 'chat', { type: 'respondToQuestion', requestId: request.requestId, response: { answers: [] } })).rejects.toThrow('no longer pending')
  })
})
