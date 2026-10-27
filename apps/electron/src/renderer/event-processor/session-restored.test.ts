import { describe, expect, it } from 'bun:test'
import { processEvent } from './processor'
import type { SessionState } from './types'

const session = (ids: string[], isProcessing = true): SessionState['session'] => ({
  id: 'chat', workspaceId: 'workspace', workspaceName: 'Fixture', projectId: 'selected-project', lastMessageAt: 1, isProcessing,
  worktree: { repositoryPath: '/repo', owned: { version: 1, ownerId: 'workspace/chat', token: 'owner', repoPath: '/repo', gitDir: '/repo/.git',
    path: '/checkout', branch: 'developer/topic', base: 'main', baseCommit: 'abc', status: 'ready' } },
  messages: ids.map(id => ({ id, role: 'user' as const, content: id, timestamp: 1 })),
})
describe('checkpoint restoration across open windows', () => {
  it('replaces both windows’ future and optimistic messages and clears stale streaming while retaining project + checkout', () => {
    const restored = session(['retained'], false)
    const event = { type: 'session_restored' as const, sessionId: 'chat', session: restored }
    const windows: SessionState[] = [
      { session: session(['retained', 'future']), streaming: { content: 'future streaming', turnId: 'old-turn' } },
      { session: session(['retained', 'future', 'optimistic']), streaming: { content: 'other partial reply' } },
    ]
    for (const window of windows) {
      const result = processEvent(window, event)
      expect(result.state.session.messages.map(message => message.id)).toEqual(['retained'])
      expect(result.state.streaming).toBeNull()
      expect(result.state.session.isProcessing).toBe(false)
      expect(result.state.session.projectId).toBe('selected-project')
      expect(result.state.session.worktree?.owned?.path).toBe('/checkout')
      expect(result.effects).toEqual([])
    }
    expect(windows[0]!.session.messages).toHaveLength(2)
    expect(windows[1]!.session.messages).toHaveLength(3)
  })
})
