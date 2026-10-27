import type { RepositorySelection } from '@craft-agent/shared/protocol'
import * as storage from '@/lib/local-storage'

const LIMIT = 25
export function repositoryKey(repository: RepositorySelection): string {
  if (repository.kind === 'github' || repository.nameWithOwner) return `github:${repository.nameWithOwner!.toLowerCase()}`
  return `local:${repository.gitDir.replace(/[\\/]+$/, '')}`
}
export function repositoryLabel(repository: RepositorySelection): string {
  return repository.kind === 'github' ? repository.nameWithOwner : repository.nameWithOwner ?? repository.name
}
export function isRepositorySelection(value: unknown): value is RepositorySelection {
  if (!value || typeof value !== 'object') return false
  const repo = value as Record<string, unknown>
  if (repo.kind === 'local') return typeof repo.gitDir === 'string' && !!repo.gitDir.trim() && typeof repo.name === 'string' && (repo.nameWithOwner === undefined || typeof repo.nameWithOwner === 'string')
  return repo.kind === 'github' && typeof repo.nameWithOwner === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo.nameWithOwner)
}
export function addSelectedRepository(history: RepositorySelection[], repository: RepositorySelection): RepositorySelection[] {
  const { start: _start, ...remembered } = repository
  return [remembered, ...history.filter(previous => repositoryKey(previous) !== repositoryKey(repository)
    && !(repository.kind === 'local' && repository.nameWithOwner && previous.kind === 'github' && repository.nameWithOwner.toLowerCase() === previous.nameWithOwner.toLowerCase()))].slice(0, LIMIT)
}
export function getSelectedRepositories(workspaceId?: string): RepositorySelection[] {
  const stored = storage.get<unknown>(storage.KEYS.selectedRepositories, [], workspaceId)
  return Array.isArray(stored) ? stored.filter(isRepositorySelection).slice(0, LIMIT) : []
}
export function rememberRepository(repository: RepositorySelection, workspaceId?: string): void {
  storage.set(storage.KEYS.selectedRepositories, addSelectedRepository(getSelectedRepositories(workspaceId), repository), workspaceId)
}
export function getDraftRepository(sessionId: string | undefined, workspaceId?: string): RepositorySelection | undefined {
  if (!sessionId) return
  const value = storage.get<unknown>(storage.KEYS.draftRepository, undefined, `${workspaceId ?? ''}:${sessionId}`)
  return isRepositorySelection(value) ? value : undefined
}
export function setDraftRepository(repository: RepositorySelection, sessionId: string, workspaceId?: string): void {
  storage.set(storage.KEYS.draftRepository, repository, `${workspaceId ?? ''}:${sessionId}`)
}
export function initialRepository(sessionId: string | undefined, workspaceId?: string): RepositorySelection | undefined {
  return getDraftRepository(sessionId, workspaceId) ?? getSelectedRepositories(workspaceId)[0]
}
/** Only migrate sessions with a real owned checkout, never folders found by a scan. */
export function seedSelectedRepositories(sessions: Array<{ workspaceId: string; lastMessageAt?: number; createdAt?: number; worktree?: { owned?: { gitDir: string; repoPath: string } } }>): void {
  const byWorkspace = new Map<string, typeof sessions>()
  for (const session of sessions) if (session.worktree?.owned) byWorkspace.set(session.workspaceId, [...(byWorkspace.get(session.workspaceId) ?? []), session])
  for (const [workspaceId, entries] of byWorkspace) {
    if (getSelectedRepositories(workspaceId).length) continue
    for (const entry of [...entries].sort((a, b) => (a.lastMessageAt ?? a.createdAt ?? 0) - (b.lastMessageAt ?? b.createdAt ?? 0))) {
      const owned = entry.worktree!.owned!
      const name = owned.repoPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Repository'
      rememberRepository({ kind: 'local', gitDir: owned.gitDir, name }, workspaceId)
    }
  }
}

export function clearDraftRepository(sessionId: string, workspaceId?: string): void {
  storage.remove(storage.KEYS.draftRepository, `${workspaceId ?? ''}:${sessionId}`)
}
