import { i18n } from '@craft-agent/shared/i18n';
import { normalizeProjectWorktreeSettings, type ProjectConfig } from '@craft-agent/shared/projects';
import { expandPath } from '@craft-agent/shared/utils';
import { runGit, runGitResult } from '../git';
import { commonGitDir, repoCommandDir } from './discover';

/** Check a project's repository on the workspace server before saving its worktree policy. */
export async function validateProjectWorktreeSettings(
  project: Pick<ProjectConfig, 'workingDirectory' | 'worktreeSettings'>,
): Promise<void> {
  const settings = normalizeProjectWorktreeSettings(project.worktreeSettings, project.workingDirectory);
  if (!settings?.enabled) return;

  const gitDir = await commonGitDir(expandPath(project.workingDirectory!.trim()));
  if (!gitDir) throw new Error(i18n.t('projectInfo.worktree.invalidRepository'));
  const dir = repoCommandDir(gitDir);

  if (settings.baseBranch) {
    const branch = settings.baseBranch;
    if (branch.startsWith('-') || /[\x00-\x1f\x7f]/.test(branch) || !(await runGitResult(dir, ['check-ref-format', '--branch', branch])).ok) {
      throw new Error(i18n.t('projectInfo.worktree.invalidBaseBranch'));
    }
    const candidates = branch.startsWith('origin/')
      ? [`refs/remotes/${branch}`]
      : [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`];
    for (const ref of candidates) {
      if (await runGit(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) return;
    }
    throw new Error(i18n.t('projectInfo.worktree.invalidBaseBranch'));
  }

  // Match the existing worktree creation fallback without fetching while saving settings.
  const remoteHead = await runGit(dir, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const candidates = remoteHead ? [remoteHead, 'HEAD'] : ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'HEAD'];
  for (const ref of candidates) {
    if (await runGit(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) return;
  }
  throw new Error(i18n.t('projectInfo.worktree.repositoryHasNoCommits'));
}
