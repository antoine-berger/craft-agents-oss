import { i18n } from '../i18n/index.ts';
import type { ProjectWorktreeSettings } from './types.ts';

/** Validate the persisted/RPC shape without requiring Git or touching the filesystem. */
export function normalizeProjectWorktreeSettings(
  value: unknown,
  workingDirectory: unknown,
): ProjectWorktreeSettings | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(i18n.t('projectInfo.worktree.invalidSettings'));
  }

  const settings = value as Record<string, unknown>;
  if (
    typeof settings.enabled !== 'boolean'
    || (settings.baseBranch !== undefined && typeof settings.baseBranch !== 'string')
    || (settings.cleanupOnArchive !== undefined && typeof settings.cleanupOnArchive !== 'boolean')
    || Object.keys(settings).some(key => !['enabled', 'baseBranch', 'cleanupOnArchive'].includes(key))
  ) {
    throw new Error(i18n.t('projectInfo.worktree.invalidSettings'));
  }

  if (settings.enabled && (typeof workingDirectory !== 'string' || !workingDirectory.trim())) {
    throw new Error(i18n.t('projectInfo.worktree.directoryRequired'));
  }

  return {
    enabled: settings.enabled,
    baseBranch: (settings.baseBranch as string | undefined)?.trim() || undefined,
    cleanupOnArchive: settings.cleanupOnArchive === true,
  };
}
