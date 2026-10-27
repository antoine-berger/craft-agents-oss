import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { convertConductorExport } from '../../../../shared/src/conductor-import/convert'
import { fixture } from '../../../../shared/src/conductor-import/convert.test'
import { importConductorChat, validateConductorImport } from './service'
import type { SessionBundle } from '@craft-agent/shared/sessions'
const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
test('integrity check rejects changed original; untrusted foreign SDK/path/header/files are rebuilt', () => {
  const input = convertConductorExport(fixture())
  input.bundle.session.header.sdkSessionId = 'foreign'; input.bundle.session.header.sdkCwd = '/Users/other'; input.bundle.session.header.workingDirectory = '/Users/other'
  input.bundle.files.push({ relativePath: '../../evil', contentBase64: '', size: 0 })
  const safe = validateConductorImport(input)
  expect(safe.bundle.session.header.sdkSessionId).toBeUndefined(); expect(safe.bundle.session.header.workingDirectory).toBeUndefined()
  expect(safe.bundle.files).toHaveLength(1)
  input.origin.fingerprint = 'bad'
  expect(() => validateConductorImport(input)).toThrow('integrity')
})
test('concurrent copies deduplicate; project is durable; changed source remains a distinct copy', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'craft-import-service-')); folders.push(rootPath)
  const saved: SessionBundle[] = []; const assignments: Array<[string, string | null]> = []
  const manager = {
    getSessions: () => saved.map(bundle => ({ ...bundle.session.header, workspaceId: 'target' })) as never,
    importSession: async (_workspaceId: string, bundle: SessionBundle) => { await new Promise(resolve => setTimeout(resolve, 5)); saved.push(bundle); return { sessionId: bundle.session.header.id } },
    setSessionProjectId: async (id: string, projectId: string | null) => { assignments.push([id, projectId]) },
  }
  const input = convertConductorExport(fixture())
  const results = await Promise.all([importConductorChat(manager, { id: 'target', rootPath }, input), importConductorChat(manager, { id: 'target', rootPath }, input)])
  expect(results.map(result => result.status).sort()).toEqual(['imported', 'skipped']); expect(saved).toHaveLength(1)
  expect(saved[0]?.session.header.worktree?.pendingRepository).toEqual({ kind: 'github', nameWithOwner: 'team/app' })
  expect(saved[0]?.session.header).toHaveProperty('importedFrom.provider', 'conductor'); expect(assignments).toHaveLength(1)
  const changed = fixture(); changed.messages[0]!.content += ' updated'
  const revision = await importConductorChat(manager, { id: 'target', rootPath }, convertConductorExport(changed))
  expect(saved).toHaveLength(2); expect(revision.projectId).toBe(results[0]?.projectId)
})
