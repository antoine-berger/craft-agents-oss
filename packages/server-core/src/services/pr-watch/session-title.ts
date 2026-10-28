import type { PrWatchSessionState } from '@craft-agent/shared/protocol'
import type { ISessionManager } from '../../handlers/session-manager-interface'

/** Reuse the PR watcher result; naming never performs another GitHub request. */
export async function syncSessionTitleFromPr(
  manager: Pick<ISessionManager, 'getSessionSnapshot' | 'renameSession'>,
  sessionId: string,
  state: PrWatchSessionState,
): Promise<void> {
  if (state.kind !== 'ready') return
  // Related pinned PRs must not displace the checkout's own PR. Without one,
  // a single pinned PR is unambiguous; several pinned dependencies are not.
  const primary = state.prs.find(pr => pr.origin === 'branch')
    ?? (state.prs.length === 1 ? state.prs[0] : undefined)
  const title = primary?.summary.title
  if (!title?.trim() || primary?.summary.attentionStale) return
  const session = manager.getSessionSnapshot(sessionId)
  if (!session || session.name === title) return
  await manager.renameSession(sessionId, title)
}
