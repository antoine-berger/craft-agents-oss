import { isSourceUsable, type LoadedSource } from '@craft-agent/shared/sources'

/** Virtual account sources have no authType; their live connector status is authoritative. */
export function availableSessionSourceSlugs(sources: readonly LoadedSource[]): string[] {
  return [...new Set(sources.filter(source => source.claudeAccount
    ? source.config.enabled && source.config.connectionStatus === 'connected' && source.config.isAuthenticated === true
    : isSourceUsable(source)).map(source => source.config.slug))].sort()
}
