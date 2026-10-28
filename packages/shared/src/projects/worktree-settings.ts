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
    || (settings.setupCommand !== undefined && (typeof settings.setupCommand !== 'string' || settings.setupCommand.length > 16_384 || settings.setupCommand.includes('\0')))
    || (settings.setupVerifyCommand !== undefined && (typeof settings.setupVerifyCommand !== 'string' || settings.setupVerifyCommand.length > 16_384 || settings.setupVerifyCommand.includes('\0')))
    || Object.keys(settings).some(key => !['enabled', 'baseBranch', 'cleanupOnArchive', 'setupCommand', 'setupVerifyCommand'].includes(key))
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
    ...(typeof settings.setupCommand === 'string' && settings.setupCommand.trim() ? { setupCommand: settings.setupCommand.trim() } : {}),
    ...(typeof settings.setupVerifyCommand === 'string' && settings.setupVerifyCommand.trim() ? { setupVerifyCommand: settings.setupVerifyCommand.trim() } : {}),
  };
}
