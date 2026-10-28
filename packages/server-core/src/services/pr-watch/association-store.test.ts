import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diskPrAssociations, prAssociationPath, savedPrSummary, type PrAssociation } from './association-store'

const roots: string[] = []
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'craft-pr-durable-')); roots.push(dir); return dir }
const saved: PrAssociation = { coords: { host: 'github.com', owner: 'acme', repo: 'app' }, number: 7,
  title: 'Feature', url: 'https://github.com/acme/app/pull/7', headRef: 'feat/x', baseRef: 'main',
  headOid: 'abc', state: 'open', fetchedAt: 1000, via: 'gh' }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })

test('association survives a new store reader on disk, without storing CI/review payloads', () => {
  const dir = root(), key = 'branch|/repo|github.com/acme/app@feat/x'
  diskPrAssociations.save(dir, key, saved)
  expect(diskPrAssociations.load(dir, key)).toEqual(saved)
  const file = prAssociationPath(dir, key)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(statSync(file).size).toBeLessThan(1024)
  expect(readdirSync(join(dir, 'pr-associations'))).toEqual([file.split('/').at(-1)!])
  const summary = savedPrSummary(saved)
  expect(summary).toMatchObject({ attentionStale: true, headMatchesLocal: null, checks: 'none', mergeState: 'unknown' })
  expect(summary.quickActions).toBeUndefined()
  expect(summary.attentionFeedback).toBeUndefined()
})

test('unchanged poll timestamps do not rewrite a durable identity, and older observations cannot replace it', () => {
  const dir = root(), key = 'key'
  diskPrAssociations.save(dir, key, saved)
  const file = prAssociationPath(dir, key), before = statSync(file), content = readFileSync(file, 'utf8')
  diskPrAssociations.save(dir, key, { ...saved, fetchedAt: 2000 })
  expect(statSync(file).ino).toBe(before.ino)
  expect(readFileSync(file, 'utf8')).toBe(content)
  diskPrAssociations.save(dir, key, { ...saved, title: 'New title', fetchedAt: 3000 })
  diskPrAssociations.save(dir, key, { ...saved, title: 'Older title', fetchedAt: 1000 })
  expect(diskPrAssociations.load(dir, key)?.title).toBe('New title')
})

test('corrupt, oversized, mismatched and missing records cannot invent a PR link', () => {
  const dir = root(), key = 'key'
  expect(diskPrAssociations.load(dir, key)).toBeNull()
  diskPrAssociations.save(dir, key, saved)
  const file = prAssociationPath(dir, key)
  for (const data of ['{broken', 'x'.repeat(20_000), JSON.stringify({ version: 1, key: 'other', association: saved }),
    JSON.stringify({ version: 1, key, association: { ...saved, url: 'https://github.com/other/repo/pull/7' } })]) {
    writeFileSync(file, data)
    expect(diskPrAssociations.load(dir, key)).toBeNull()
  }
})

test('a separate backend process restores the primary link with GitHub completely unavailable', () => {
  const dir = root(), key = 'branch|/repo|github.com/acme/app@feat/x'
  const module = JSON.stringify(new URL('./association-store.ts', import.meta.url).href)
  const writer = Bun.spawnSync([process.execPath, '-e', `
    const {diskPrAssociations}=await import(${module});
    diskPrAssociations.save(${JSON.stringify(dir)}, ${JSON.stringify(key)}, ${JSON.stringify(saved)});
  `])
  expect(writer.exitCode).toBe(0)
  const registry = JSON.stringify(new URL('./registry.ts', import.meta.url).href)
  const reader = Bun.spawnSync([process.execPath, '-e', `
    const {diskPrAssociations}=await import(${module});const {PrWatchRegistry}=await import(${registry});
    const registry=new PrWatchRegistry({associations:diskPrAssociations,
      graphql:async()=>{throw new Error('GitHub unavailable')},
      candidates:async()=>[{id:'test',label:'test',getToken:async()=>'test'}],push:()=>{},
      resolveRepo:async()=>({root:'/repo',gitDir:'/repo/.git',commonDir:'/repo/.git',branch:'feat/x',remoteBranch:'feat/x',
        pushRemote:'origin',repo:{host:'github.com',owner:'acme',repo:'app'},upstreamRepo:null}),
      localStatus:async()=>({localAhead:0,localDirty:false}),watchRefs:()=>()=>{},setTimer:()=>0,clearTimer:()=>{}});
    await registry.subscribe({clientId:'ui',sessionId:'chat',dir:'/repo',workspaceRootPath:${JSON.stringify(dir)}});
    await new Promise(resolve=>setTimeout(resolve,0));console.log(JSON.stringify(registry.cachedSessionState('chat')));registry.dispose();
  `])
  expect(reader.exitCode).toBe(0)
  const state = JSON.parse(new TextDecoder().decode(reader.stdout))
  expect(state).toMatchObject({ kind: 'ready', prs: [{ origin: 'branch', summary: {
    number: 7, url: saved.url, attentionStale: true, headMatchesLocal: null, checks: 'none' } }] })
})
