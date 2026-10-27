import { afterEach, expect, test } from 'bun:test'
import { initializeModeState, cleanupModeState } from '../../mode-manager'
import { runPreToolUseChecks, type PreToolUseInput } from '../pre-tool-use'
const SESSION = 'host-tool-policy-fixture'
afterEach(() => cleanupModeState(SESSION))
function input(): PreToolUseInput {
  initializeModeState(SESSION, 'allow-all')
  return { sessionId: SESSION, permissionMode: 'allow-all', toolName: 'Bash', input: { command: 'gh pr merge 1' }, workspaceRootPath: '/fixture', workspaceId: 'fixture', activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false, permissionManager: { isCommandWhitelisted: () => true, getBaseCommand: command => command, isDomainWhitelisted: () => true } }
}
test('a host denial runs before Execute permissions and cannot be whitelisted away', () => {
  const ctx = input(); const calls: unknown[][] = []
  ctx.toolPolicy = (name, args) => { calls.push([name, args]); return 'Ship never merges' }
  expect(runPreToolUseChecks(ctx)).toEqual({ type: 'block', reason: 'Ship never merges' })
  expect(calls).toEqual([['Bash', { command: 'gh pr merge 1' }]])
})
test('policy receives real normalized MCP name and arguments before source activation', () => {
  const ctx = input(); ctx.toolName = 'mcp__linear__update_issue'; ctx.input = { id: 'ENG-1', state: 'Done' }
  ctx.toolPolicy = (name, args) => name === 'mcp__linear__update_issue' && args.id === 'ENG-1' ? 'Reviewer is read-only' : null
  expect(runPreToolUseChecks(ctx)).toEqual({ type: 'block', reason: 'Reviewer is read-only' })
})
test('throwing host policies fail closed and never expose exception contents', () => {
  const ctx = input(); ctx.toolPolicy = () => { throw new Error('SECRET-SENTINEL') }
  const result = runPreToolUseChecks(ctx)
  expect(result.type).toBe('block'); expect(JSON.stringify(result)).not.toContain('SECRET-SENTINEL')
})
