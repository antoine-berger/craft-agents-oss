import { describe, expect, it } from 'bun:test'
import { ClaudeAgent } from '../claude-agent'
import { PendingSteers } from '../backend/claude/pending-steers'

function idleAgent() {
  return Object.assign(Object.create(ClaudeAgent.prototype), {
    currentQuery: {}, keepBackgroundTasksAlive: true, persistentInput: {},
    activeTurnChannel: null, activeTurnState: null, stoppedTurn: null,
    pendingPermissions: new Map(), pendingSteers: new PendingSteers(),
  }) as any
}
describe('Claude persistent-query idle boundary', () => {
  it('distinguishes an idle persistent process from a running turn', () => {
    const agent = idleAgent()
    expect(agent.isProcessing()).toBe(true)
    expect(agent.canReleaseIdleRuntime()).toBe(true)
  })
  it.each([{ activeTurnChannel: {} }, { activeTurnState: {} }, { stoppedTurn: {} },
    { pendingPermissions: new Map([['permission', {}]]) }, { keepBackgroundTasksAlive: false }, { persistentInput: null }])('protects unfinished SDK work: %j', state => {
    const agent = Object.assign(idleAgent(), state)
    expect(agent.canReleaseIdleRuntime()).toBe(false)
  })
  it('protects a still-active steer hook', () => {
    const agent = idleAgent(); agent.pendingSteers.begin()
    expect(agent.canReleaseIdleRuntime()).toBe(false)
  })
})
