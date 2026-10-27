import { convertConductorExport, conductorHash, type ConductorRawExport } from '../../../../shared/src/conductor-import/convert'
import type { ConductorImportBundle, ConductorImportOptions, ConductorImportResult } from '../../../../shared/src/protocol/conductor-import'
import type { SessionBundle } from '@craft-agent/shared/sessions'
import type { ISessionManager } from '../../handlers/session-manager-interface'
import { createProject, loadProjectById, loadWorkspaceProjects } from '@craft-agent/shared/projects'
import type { RepositorySelection } from '../../../../shared/src/protocol/git-repos'

// Serialize check-and-create for imports across all windows connected to this server.
const imports = new Map<string, Promise<unknown>>()
async function exclusive<T>(workspaceId: string, run: () => Promise<T>): Promise<T> {
  const previous = imports.get(workspaceId) ?? Promise.resolve()
  const pending = previous.catch(() => {}).then(run)
  imports.set(workspaceId, pending)
  try { return await pending } finally { if (imports.get(workspaceId) === pending) imports.delete(workspaceId) }
}
function validateRepository(value: RepositorySelection | undefined): RepositorySelection | undefined {
  if (!value) return undefined
  if (value.kind === 'github' && /^[\w.-]+\/[\w.-]+$/.test(value.nameWithOwner) && !value.nameWithOwner.includes('..')) return { kind: 'github', nameWithOwner: value.nameWithOwner }
  if (value.kind === 'local' && typeof value.gitDir === 'string' && value.gitDir.startsWith('/') && !value.gitDir.includes('\0') && typeof value.name === 'string') return { kind: 'local', gitDir: value.gitDir, name: value.name.slice(0, 200), nameWithOwner: value.nameWithOwner }
  throw new Error('Choose a repository on the Craft server before continuing this chat.')
}
/** Rebuild from the original export instead of trusting writable session headers, SDK IDs or file paths. */
export function validateConductorImport(envelope: ConductorImportBundle): ConductorImportBundle {
  if (envelope?.version !== 1 || envelope.origin?.provider !== 'conductor') throw new Error('Invalid Conductor import')
  const file = envelope.bundle?.files?.find(file => file.relativePath === 'data/conductor-original.json')
  if (!file || file.size > 64 * 1024 * 1024 || file.contentBase64.length > 90 * 1024 * 1024) throw new Error('Missing or oversized Conductor original export')
  const bytes = Buffer.from(file.contentBase64, 'base64')
  if (bytes.length !== file.size || conductorHash(bytes.toString('utf8')) !== envelope.origin.fingerprint) throw new Error('Conductor export integrity check failed')
  let raw: ConductorRawExport
  try { raw = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Invalid Conductor original export JSON') }
  const clean = convertConductorExport(raw)
  if (clean.origin.sessionId !== envelope.origin.sessionId || clean.origin.fingerprint !== envelope.origin.fingerprint) throw new Error('Conductor source identity mismatch')
  return clean
}

export async function importConductorChat(
  manager: Pick<ISessionManager, 'getSessions' | 'importSession' | 'setSessionProjectId'>,
  workspace: { id: string; rootPath: string },
  envelope: ConductorImportBundle,
  options: ConductorImportOptions = {},
): Promise<ConductorImportResult> {
  const clean = validateConductorImport(envelope)
  const repository = validateRepository(options.repository ?? (clean.preview.repository ? { kind: 'github', nameWithOwner: clean.preview.repository } : undefined))
  return exclusive(workspace.id, async () => {
    const header = clean.bundle.session.header
    const existing = manager.getSessions(workspace.id).find(session => session.id === header.id)
    if (existing) return { status: 'skipped', sessionId: existing.id, projectId: existing.projectId, warnings: ['This exact Conductor export has already been imported.'] }
    let projectId: string
    if (options.projectId) {
      const project = loadProjectById(workspace.rootPath, options.projectId)
      if (!project) throw new Error('The selected Craft project no longer exists.')
      projectId = project.config.id
    } else {
      const key = clean.origin.repositoryId || clean.origin.workspaceId || 'unassigned'
      const marker = `Imported Conductor chats (${key})`
      const existingProject = loadWorkspaceProjects(workspace.rootPath).find(project => project.config.description === marker)
      projectId = existingProject?.config.id ?? createProject(workspace.rootPath, {
        name: clean.preview.repositoryName || clean.preview.workspaceName || 'Conductor imports', description: marker,
      }).id
    }
    // Never carry a Mac path, foreign worktree ownership or vendor SDK resume handle to Linux.
    const safeBundle: SessionBundle = { ...clean.bundle, session: { ...clean.bundle.session, header: {
      ...header, workspaceRootPath: workspace.rootPath, projectId,
      worktree: { repositoryPath: '', needsRepository: !repository, pendingRepository: repository, resolvedStart: { taskTitle: header.name } },
      importedFrom: clean.origin,
    } } }
    const result = await manager.importSession(workspace.id, safeBundle, 'move')
    // Also persist via the existing project-binding path (including older session-manager hosts).
    await manager.setSessionProjectId(result.sessionId, projectId)
    return { status: 'imported', sessionId: result.sessionId, projectId, warnings: [...clean.warnings, ...(result.warnings || []), ...(!repository ? ['Choose a repository on the server to continue this imported chat.'] : [])] }
  })
}
