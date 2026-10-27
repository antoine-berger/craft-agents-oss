import { describe, expect, it, mock } from 'bun:test'
import type { LoadedSource } from '@craft-agent/shared/sources'
import { availableSessionSourceSlugs } from './automatic-session-sources'
import { SessionManager, createManagedSession } from './SessionManager'

type Managed = ReturnType<typeof createManagedSession>
const source = (slug: string, config: Record<string, unknown> = {}, proxy = false): LoadedSource => ({
 config: {slug, name:slug, enabled:true, type:'mcp', mcp:{authType:'none'}, ...config},
 ...(proxy ? {claudeAccount:{proxy:{accountId:'account',serverId:'server'}}} : {}),
} as LoadedSource)
const catalog = [
 source('api', {type:'api',mcp:undefined,api:{authType:'none'}}), source('public'), source('private', {mcp:{authType:'oauth'},isAuthenticated:true}),
 source('disabled', {enabled:false}), source('needs-login', {mcp:{authType:'oauth'},isAuthenticated:false}),
 source('proxy-ready', {mcp:undefined,connectionStatus:'connected',isAuthenticated:true},true),
 source('proxy-failed', {mcp:undefined,connectionStatus:'failed',isAuthenticated:false},true),
 source('proxy-needs-login', {mcp:undefined,connectionStatus:'needs_auth',isAuthenticated:false},true),
 source('local-folder', {type:'local',mcp:undefined}),
]
function harness(initial: string[] | undefined, hidden = false) {
 const manager = Object.create(SessionManager.prototype) as any
 const managed = {id:'session',workspace:{id:'workspace'},enabledSourceSlugs:initial,hidden} as Managed
 manager.loadSessionSources = mock(async () => catalog)
 manager.persistSession = mock(() => {})
 manager.sendEvent = mock(() => {})
 manager.getOrCreatePreparedAgent = mock(async () => ({slugs:managed.enabledSourceSlugs}))
 return {manager,managed}
}
describe('automatic session connectors', () => {
 it('enables usable MCP, API/local and connected proxy sources without attempting unavailable connectors', () => {
  expect(availableSessionSourceSlugs(catalog)).toEqual(['api','local-folder','private','proxy-ready','public'])
 })
 it('replaces an old empty or partial selection before starting the backend', async () => {
  for (const selection of [undefined, [], ['public']]) {
   const {manager,managed}=harness(selection)
   const backend=await manager.getOrCreateAgent(managed)
   expect(backend.slugs).toEqual(['api','local-folder','private','proxy-ready','public'])
   expect(manager.sendEvent).toHaveBeenCalledTimes(1)
   expect(manager.persistSession).toHaveBeenCalledTimes(1)
  }
 })
 it('ignores legacy manual subset requests and keeps every available connector enabled', async () => {
  const {manager,managed}=harness([])
  manager.sessions = new Map([[managed.id,managed]])
  await manager.setSessionSources(managed.id, ['public'])
  expect(managed.enabledSourceSlugs).toEqual(['api','local-folder','private','proxy-ready','public'])
 })
 it('adds a newly connected source and removes a source that is no longer available on the next turn', async () => {
  const {manager,managed}=harness(['public'])
  await manager.syncAutomaticSessionSources(managed)
  manager.loadSessionSources = mock(async () => [source('newly-connected'),source('public',{enabled:false})])
  await manager.syncAutomaticSessionSources(managed)
  expect(managed.enabledSourceSlugs).toEqual(['newly-connected'])
 })
 it('does not persist or broadcast again when the available set is unchanged', async () => {
  const {manager,managed}=harness(['public'])
  await manager.syncAutomaticSessionSources(managed)
  await manager.syncAutomaticSessionSources(managed)
  expect(manager.persistSession).toHaveBeenCalledTimes(1)
  expect(manager.sendEvent).toHaveBeenCalledTimes(1)
 })
 it('keeps hidden title and metadata helpers free of connector discovery', async () => {
  const {manager,managed}=harness([],true)
  await manager.getOrCreateAgent(managed)
  expect(manager.loadSessionSources).not.toHaveBeenCalled()
  expect(managed.enabledSourceSlugs).toEqual([])
 })
})
