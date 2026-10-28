import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cancelSessionSearchesForClient, cancelSessionSearchRequest, searchSessions, searchSessionsDetailed, setSearchPlatform } from './search'
import type { PlatformServices } from '../runtime/platform'

const root = mkdtempSync(join(tmpdir(), 'craft-search-'))
const bin = join(root, 'node_modules', '@vscode', 'ripgrep', 'bin')
mkdirSync(bin, { recursive: true })
writeFileSync(join(bin, 'rg'), `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const dir=process.argv.at(-1),plan=JSON.parse(fs.readFileSync(path.join(dir,'fixture.json'),'utf8'));
for(const id of plan.ids||[]){process.stdout.write(JSON.stringify({type:'match',data:{path:{text:path.join(dir,id,'session.jsonl')},line_number:2,lines:{text:'{"type":"user","content":"hello café"}'},submatches:[{match:{text:'hello'}}]}})+'\\n')}
process.stdout.write('',()=>fs.writeFileSync(path.join(dir,'ready'),'ready'));
setTimeout(()=>process.exit(plan.code||0),plan.delay||0);
`, { mode: 0o755 })
const logger = { info() {}, debug() {}, warn() {}, error() {} }
const fakePlatform = { appRootPath: root, resourcesPath: root, isPackaged: true, logger } as PlatformServices
setSearchPlatform(fakePlatform)
let count = 0
function fixture(ids: string[], delay = 0, code = 0): string {
  const directory = join(root, `case-${count++}`)
  mkdirSync(directory)
  writeFileSync(join(directory, 'fixture.json'), JSON.stringify({ ids, delay, code }))
  return directory
}
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

describe('scoped content search', () => {
  test('different clients search the same workspace concurrently', async () => {
    const [a, b] = await Promise.all([
      searchSessionsDetailed('hello', fixture(['a'], 80), { scope: { clientId: 'a', workspaceId: 'one' } }),
      searchSessionsDetailed('hello', fixture(['b']), { scope: { clientId: 'b', workspaceId: 'one' } }),
    ])
    expect([a.status, b.status]).toEqual(['complete', 'complete'])
    expect(a.results[0]?.sessionId).toBe('a')
    expect(b.results[0]?.sessionId).toBe('b')
  })
  test('one client can search two workspaces without interference', async () => {
    const responses = await Promise.all(['one', 'two'].map(workspaceId => searchSessionsDetailed('hello', fixture([workspaceId], 50), { scope: { clientId: 'same', workspaceId } })))
    expect(responses.map(response => response.status)).toEqual(['complete', 'complete'])
  })
  test('new query cancels only the same client/workspace and keeps its request identity', async () => {
    const options = { scope: { clientId: 'typing', workspaceId: 'one' } }
    const old = searchSessionsDetailed('hello', fixture(['old'], 1000), { ...options, searchId: 'old' })
    const current = searchSessionsDetailed('hello', fixture(['current'], 50), { ...options, searchId: 'new' })
    expect((await old).status).toBe('cancelled')
    expect(await current).toMatchObject({ status: 'complete', searchId: 'new', results: [{ sessionId: 'current' }] })
  })
  test('disconnect cancels that client while another client continues', async () => {
    const gone = searchSessionsDetailed('hello', fixture(['gone'], 1000), { scope: { clientId: 'gone', workspaceId: 'one' } })
    const kept = searchSessionsDetailed('hello', fixture(['kept'], 60), { scope: { clientId: 'kept', workspaceId: 'one' } })
    cancelSessionSearchesForClient('gone')
    expect((await gone).status).toBe('cancelled')
    expect((await kept).status).toBe('complete')
  })
  test('closing an old query cannot cancel its replacement', async () => {
    const scope = { clientId: 'closing', workspaceId: 'one' }
    const old = searchSessionsDetailed('hello', fixture(['old'], 1000), { scope, searchId: 'old' })
    const current = searchSessionsDetailed('hello', fixture(['new'], 50), { scope, searchId: 'new' })
    cancelSessionSearchRequest('closing', 'one', 'old')
    expect((await old).status).toBe('cancelled')
    expect((await current).status).toBe('complete')
    const closing = searchSessionsDetailed('hello', fixture(['closing'], 1000), { scope, searchId: 'closing' })
    cancelSessionSearchRequest('closing', 'one', 'closing')
    expect((await closing).status).toBe('cancelled')
  })
  test('timeout returns partial matches with an explicit timed_out status', async () => {
    const directory = fixture(['partial'], 20_000)
    const schedule = globalThis.setTimeout
    let expire: (() => void) | undefined
    const deadline = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 300) {
        expire = () => callback(...args)
        return schedule(() => {}, 2_147_483_647)
      }
      return schedule(callback, delay, ...args)
    }) as typeof globalThis.setTimeout)
    const pending = searchSessionsDetailed('hello', directory, { timeout: 300, scope: { clientId: 'timeout', workspaceId: 'one' } })
    try {
      const start = Date.now()
      while (!existsSync(join(directory, 'ready'))) {
        if (Date.now() - start > 10_000) throw new Error('Search fixture did not report stdout readiness.')
        await new Promise(resolve => schedule(resolve, 5))
      }
      expect(expire).toBeDefined()
      expire!()
      const response = await pending
      expect(response.status).toBe('timed_out')
      expect(response.results[0]?.sessionId).toBe('partial')
    } finally {
      cancelSessionSearchesForClient('timeout')
      await pending
      deadline.mockRestore()
    }
  }, 15_000)
  test('process failure is partial after matches and unavailable without matches', async () => {
    const partial = await searchSessionsDetailed('hello', fixture(['partial'], 0, 2))
    const unavailable = await searchSessionsDetailed('hello', fixture([], 0, 2))
    expect(partial.status).toBe('partial')
    expect(unavailable).toMatchObject({ status: 'unavailable', results: [] })
  })
  test('hidden histories do not consume the snippet budget; all visible matches are counted', async () => {
    const response = await searchSessionsDetailed('hello', fixture(['hidden', 'visible', 'other']), { allowedSessionIds: new Set(['visible', 'other']), maxSessions: 1 })
    expect(response.results.map(result => result.sessionId)).toEqual(['visible', 'other'])
    expect(response.results[0]?.matches[0]?.snippet).toContain('café')
    expect(response.results[1]?.matches).toEqual([])
  })
  test('legacy callers still receive arrays and unscoped searches do not cancel each other', async () => {
    const results = await Promise.all([searchSessions('hello', fixture(['a'], 40)), searchSessions('hello', fixture(['b']))])
    expect(results.map(entries => entries[0]?.sessionId)).toEqual(['a', 'b'])
  })
  test('a missing runtime/spawn error is unavailable, never a successful empty answer', async () => {
    const executable = join(bin, 'rg')
    const previous = readFileSync(executable)
    try {
      writeFileSync(executable, '#!/craft-search-missing-runtime\n')
      expect(await searchSessionsDetailed('hello', fixture([]))).toMatchObject({ status: 'unavailable', results: [] })
      await expect(searchSessions('hello', fixture([]))).rejects.toThrow('unavailable')
    } finally { writeFileSync(executable, previous) }
  })
  test('real ripgrep still finds a final message after ten matching intermediate messages', async () => {
    const directory = fixture([])
    const chat = join(directory, 'visible')
    mkdirSync(chat)
    writeFileSync(join(chat, 'session.jsonl'), [
      JSON.stringify({ id: 'visible' }),
      ...Array.from({ length: 10 }, (_, index) => JSON.stringify({ id: String(index), type: 'assistant', content: 'needle-real-search', isIntermediate: true })),
      JSON.stringify({ id: 'final', type: 'assistant', content: 'needle-real-search final' }),
    ].join('\n') + '\n')
    const repository = resolve(import.meta.dir, '../../../..')
    setSearchPlatform({ ...fakePlatform, appRootPath: repository, resourcesPath: repository })
    try {
      const response = await searchSessionsDetailed('needle-real-search', directory)
      expect(response.status).toBe('complete')
      expect(response.results[0]?.sessionId).toBe('visible')
      expect(response.results[0]?.matches[0]?.lineNumber).toBe(12)
      expect(response.results[0]?.matches[0]?.snippet).toContain('final')
    } finally { setSearchPlatform(fakePlatform) }
  })
})
