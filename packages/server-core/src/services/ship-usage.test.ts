import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readShipUsage } from './ship-usage'
let root: string
let folder: string
const attempt = (patch: Record<string, unknown> = {}) => ({ version: 1, id: 'one', role: 'bugs', requestedModel: 'gpt-6-astra', servedModel: null, provider: 'CLIProxyAPI', account: null, accountAttribution: 'unknown', effort: 'high', round: 1, startedAt: 100, durationMs: 300, status: 'completed', inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, ...patch })
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'craft-ship-usage-')); execFileSync('git', ['init', '-q', root]); folder = join(root, '.context/ship/reviewers/bugs-r1'); await mkdir(folder, { recursive: true }) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
test('reads only whitelisted measured fields and resolves a repository subdirectory', async () => {
  await mkdir(join(root, 'src'))
  await writeFile(join(folder, 'usage.jsonl'), JSON.stringify(attempt({ prompt: 'secret input', apiKey: 'secret key', email: 'private@example.com' })) + '\n')
  const snapshot = await readShipUsage(join(root, 'src'))
  expect(snapshot).toMatchObject({ coverage: 'codex-helper-only', accountAttribution: 'unknown', truncated: false })
  expect(snapshot.attempts).toHaveLength(1)
  expect(snapshot.attempts[0]).toMatchObject({ requestedModel: 'gpt-6-astra', servedModel: null, inputTokens: 10 })
  expect(JSON.stringify(snapshot)).not.toContain('secret')
  expect(JSON.stringify(snapshot)).not.toContain('example.com')
})
test('invalid or partial records cannot become fabricated token measurements', async () => {
  await writeFile(join(folder, 'usage.jsonl'), [JSON.stringify(attempt({ inputTokens: '10' })), '{partial', JSON.stringify(attempt({ role: 'invented' })), JSON.stringify(attempt({ id: 'valid', inputTokens: null, status: 'failed' }))].join('\n'))
  const snapshot = await readShipUsage(root)
  expect(snapshot.attempts).toHaveLength(1)
  expect(snapshot.attempts[0]).toMatchObject({ id: 'valid', inputTokens: null, status: 'failed' })
})
test('symlinked reviewer history outside the checkout is not read', async () => {
  const external = await mkdtemp(join(tmpdir(), 'craft-external-usage-'))
  try {
    await writeFile(join(external, 'usage.jsonl'), JSON.stringify(attempt()))
    await symlink(join(external, 'usage.jsonl'), join(folder, 'usage.jsonl'))
    expect((await readShipUsage(root)).attempts).toHaveLength(0)
  } finally { await rm(external, { recursive: true, force: true }) }
})
test('history is capped and reports partial coverage explicitly', async () => {
  await writeFile(join(folder, 'usage.jsonl'), Array.from({ length: 205 }, (_, index) => JSON.stringify(attempt({ id: `call-${index}`, startedAt: index }))).join('\n'))
  const snapshot = await readShipUsage(root)
  expect(snapshot.truncated).toBe(true)
  expect(snapshot.attempts).toHaveLength(200)
  expect(snapshot.attempts[0]?.startedAt).toBe(204)
})
test('a missing history or nonrepository directory has no measured attempts', async () => {
  await rm(join(root, '.context'), { recursive: true, force: true })
  expect((await readShipUsage(root)).attempts).toHaveLength(0)
  const plain = await mkdtemp(join(tmpdir(), 'craft-plain-usage-'))
  try { expect((await readShipUsage(plain)).attempts).toHaveLength(0) } finally { await rm(plain, { recursive: true, force: true }) }
})
