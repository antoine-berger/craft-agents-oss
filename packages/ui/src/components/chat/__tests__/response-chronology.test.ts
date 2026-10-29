import { expect, it } from 'bun:test'
import { messageToStored, storedToMessage, type Message } from '@craft-agent/core/types'
import { groupMessagesByTurn, type AssistantTurn } from '../turn-utils'

it('uses stream starts for transcript ordering and completion times for footer duration, live and reloaded', () => {
  const messages: Message[] = [
    { id: 'u', role: 'user', content: 'Request', timestamp: 1 },
    { id: 'tool', role: 'tool', toolUseId: 't', toolName: 'Read', toolStatus: 'completed', content: '', timestamp: 20 },
    { id: 'before', role: 'assistant', content: 'Before', startedAt: 10, timestamp: 30, isIntermediate: true },
    { id: 'after', role: 'assistant', content: 'After', startedAt: 35, timestamp: 50, responseUsage: { outputTokens: 7 } },
  ]
  for (const history of [messages, messages.map(message => storedToMessage(JSON.parse(JSON.stringify(messageToStored(message)))))]) {
    const turn = groupMessagesByTurn(history).find(turn => turn.type === 'assistant') as AssistantTurn
    expect(turn.activities.map(activity => activity.id)).toEqual(['before', 'tool'])
    expect(turn.response).toMatchObject({ text: 'After', timestamp: 50, durationMs: 49, responseUsage: { outputTokens: 7 } })
  }
})
