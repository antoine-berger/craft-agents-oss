import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GithubWebhookReceiver, MAX_WEBHOOK_BYTES } from './receiver'
import type { GithubWebhookChange } from './events'

const config = { secret: 'test-only-32-character-webhook-secret', repositories: ['acme/*'] }
const change: GithubWebhookChange = { repo: { host: 'github.com', owner: 'acme', repo: 'app' }, numbers: [7], shas: [], headRefs: [], baseRefs: [], all: false }
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

function setup(onChange: (change: GithubWebhookChange) => Promise<number | null> = async () => null) {
  const dir = mkdtempSync(join(tmpdir(), 'craft-webhook-inbox-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'inbox.json')
  const receiver = new GithubWebhookReceiver({ config, statePath: path, onChange })
  cleanup.push(() => receiver.stop())
  return { dir, path, receiver, read: () => JSON.parse(readFileSync(path, 'utf8')) }
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Inbox state did not settle')
    await Bun.sleep(10)
  }
}

describe('bounded durable GitHub webhook inbox', () => {
  it('records accepted work privately before processing and deduplicates a cold replay', () => {
    const t = setup()
    const id = randomUUID()
    expect(t.receiver.accept(id, change)).toBe('accepted')
    expect(t.read().pending.map((item: any) => item.id)).toEqual([id])
    expect(statSync(t.path).mode & 0o777).toBe(0o600)
    const cold = new GithubWebhookReceiver({ config, statePath: t.path, onChange: async () => null })
    expect(cold.accept(id, change)).toBe('duplicate')
  })

  it('never accepts a state file that its constructor cannot reload', () => {
    const t = setup()
    const large = { ...change, headRefs: Array.from({ length: 1300 }, (_, i) => `${i}-` + 'x'.repeat(995)) }
    t.receiver.accept(randomUUID(), large)
    const before = readFileSync(t.path)
    expect(() => t.receiver.accept(randomUUID(), large)).toThrow('byte limit')
    expect(readFileSync(t.path)).toEqual(before)
    expect(statSync(t.path).size).toBeLessThan(MAX_WEBHOOK_BYTES)
    expect(() => new GithubWebhookReceiver({ config, statePath: t.path, onChange: async () => null })).not.toThrow()
  })

  it('does not mutate or overwrite an invalid persisted inbox', () => {
    const t = setup()
    writeFileSync(t.path, '{broken')
    expect(() => new GithubWebhookReceiver({ config, statePath: t.path, onChange: async () => null })).toThrow()
    expect(readFileSync(t.path, 'utf8')).toBe('{broken')
  })

  it('does not acknowledge or remember an event when writing the inbox fails', () => {
    const t = setup()
    const blocked = join(t.dir, 'file')
    writeFileSync(blocked, 'preserve')
    const receiver = new GithubWebhookReceiver({ config, statePath: join(blocked, 'inbox.json'), onChange: async () => null })
    expect(() => receiver.accept(randomUUID(), change)).toThrow()
    expect(readFileSync(blocked, 'utf8')).toBe('preserve')
    expect(existsSync(t.path)).toBe(false)
  })

  it('coalesces ready deliveries and persists quota deferral until it may retry', async () => {
    let calls = 0
    const t = setup(async batch => { calls++; expect(batch.numbers).toEqual([7, 8]); return 60_000 })
    t.receiver.accept(randomUUID(), change)
    t.receiver.accept(randomUUID(), { ...change, numbers: [8] })
    t.receiver.start()
    await until(() => calls === 1)
    await Bun.sleep(50)
    expect(t.read().pending).toHaveLength(2)
    expect(t.read().pending[0].retryAt).toBeGreaterThan(Date.now() + 50_000)
    expect(t.read().seen).toEqual([])
  })

  it('a ready event for another repository does not wait for an older deferred event', async () => {
    const calls: string[] = []
    const t = setup(async batch => { calls.push(batch.repo.repo); return batch.repo.repo === 'app' ? 60_000 : null })
    t.receiver.accept(randomUUID(), change)
    t.receiver.start()
    await until(() => calls.length === 1)
    await Bun.sleep(30)
    t.receiver.accept(randomUUID(), { ...change, repo: { ...change.repo, repo: 'another' } })
    await until(() => calls.includes('another'))
    expect(calls).toEqual(['app', 'another'])
    expect(t.read().pending).toHaveLength(1)
    expect(t.read().seen).toHaveLength(1)
  })

  it('a delivery received during processing remains pending for a subsequent batch', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const calls: number[][] = []
    const t = setup(async batch => { calls.push(batch.numbers); if (calls.length === 1) await gate; return null })
    t.receiver.accept(randomUUID(), change)
    t.receiver.start()
    await until(() => calls.length === 1)
    t.receiver.accept(randomUUID(), { ...change, numbers: [8] })
    release()
    await until(() => calls.length === 2 && t.read().pending.length === 0)
    expect(calls).toEqual([[7], [8]])
    expect(t.read().seen).toHaveLength(2)
  })
})
