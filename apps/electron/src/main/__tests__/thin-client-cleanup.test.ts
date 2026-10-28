import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = process.env.CRAFT_CLEANUP_TEST_BUNDLE ? readFileSync(process.env.CRAFT_CLEANUP_TEST_BUNDLE, 'utf8') : readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
const start = source.indexOf('async function performQuitCleanup()')
const end = process.env.CRAFT_CLEANUP_TEST_BUNDLE ? source.indexOf('\nimport_electron', start) : source.indexOf('// Save window state and clean up resources before quitting', start)
const cleanup = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end).replace("await import('./power-manager')", 'await loadPowerManager()').replace(/await Promise\.resolve\(\)\.then\(\(\) => \(init_power_manager\(\), power_manager_exports\)\)/, 'await loadPowerManager()'))
function fixture(hosted: boolean) {
  const calls = { flush: 0, sessions: 0, models: 0, browser: 0, power: 0 }
  const manager = hosted ? { flushAllSessions: async () => { calls.flush++ }, cleanup: () => { calls.sessions++ } } : null
  const create = new Function('sessionManager', 'browserPaneManager', 'getModelRefreshService', 'loadPowerManager', `
    let quitCleanupRan = false;
    const mainLog = {info(){}, error(){}};
    const oauthFlowStore = null, messagingHandle = null;
    const releaseServerLock = () => {};
    ${cleanup}; return performQuitCleanup;
  `)
  return { calls, run: create(manager, { destroyAll: () => { calls.browser++ } }, () => {
    if (!hosted) throw new Error('ModelRefreshService not initialized. Call initModelRefreshService() first.')
    return { stopAll: () => { calls.models++ } }
  }, async () => ({ cleanup: () => { calls.power++ } })) }
}
test('real thin-client cleanup reaches installer handoff without an uninitialized model service', async () => {
  const f = fixture(false)
  await f.run()
  expect(f.calls).toEqual({ flush: 0, sessions: 0, models: 0, browser: 1, power: 1 })
})
test('hosted sessions still flush and stop their model refresh exactly once', async () => {
  const f = fixture(true); await f.run(); await f.run()
  expect(f.calls).toEqual({ flush: 1, sessions: 1, models: 1, browser: 1, power: 1 })
})
