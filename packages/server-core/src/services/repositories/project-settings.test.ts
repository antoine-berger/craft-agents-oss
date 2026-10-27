import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupI18n } from '@craft-agent/shared/i18n';
import type { ProjectWorktreeSettings } from '@craft-agent/shared/projects';
import { validateProjectWorktreeSettings } from './project-settings';

let root: string;
let repo: string;
let bareRepo: string;
let linkedWorktree: string;
let emptyRepo: string;
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeAll(() => {
  setupI18n();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'project-repo-validation-')));
  repo = join(root, 'repo');
  git(root, 'init', '-b', 'main', repo);
  writeFileSync(join(repo, 'README.md'), 'Project repository\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'Initial commit');
  git(repo, 'branch', 'release');
  git(repo, 'tag', 'release');
  git(repo, 'tag', 'only-a-tag');
  git(repo, 'tag', 'origin/only-a-remote-tag');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  mkdirSync(join(repo, 'src'));
  bareRepo = join(root, 'bare.git');
  git(root, 'clone', '--bare', repo, bareRepo);
  linkedWorktree = join(root, 'linked');
  git(repo, 'worktree', 'add', '-b', 'linked', linkedWorktree);
  emptyRepo = join(root, 'empty');
  git(root, 'init', '-b', 'main', emptyRepo);
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('project repository validation on the workspace server', () => {
  it('allows ordinary non-coding projects to keep no repository', async () => {
    await expect(validateProjectWorktreeSettings({})).resolves.toBeUndefined();
    await expect(validateProjectWorktreeSettings({
      workingDirectory: '/not/a/repository', worktreeSettings: { enabled: false },
    })).resolves.toBeUndefined();
  });

  it('accepts plain clones, repository subfolders, bare repositories and linked worktrees', async () => {
    for (const workingDirectory of [repo, join(repo, 'src'), bareRepo, linkedWorktree]) {
      await expect(validateProjectWorktreeSettings({
        workingDirectory, worktreeSettings: { enabled: true },
      })).resolves.toBeUndefined();
    }
  });

  it('accepts existing local and remote-tracking base branches without fetching', async () => {
    for (const baseBranch of ['main', 'release', 'origin/main', '  release  ']) {
      await expect(validateProjectWorktreeSettings({
        workingDirectory: repo, worktreeSettings: { enabled: true, baseBranch },
      })).resolves.toBeUndefined();
    }
  });

  it('rejects missing directories, non-repositories and repositories with no commit', async () => {
    await expect(validateProjectWorktreeSettings({
      worktreeSettings: { enabled: true },
    })).rejects.toThrow('Choose a repository folder');
    for (const workingDirectory of [root, join(root, 'does-not-exist')]) {
      await expect(validateProjectWorktreeSettings({
        workingDirectory, worktreeSettings: { enabled: true },
      })).rejects.toThrow('Choose a Git repository');
    }
    await expect(validateProjectWorktreeSettings({
      workingDirectory: emptyRepo, worktreeSettings: { enabled: true },
    })).rejects.toThrow('no usable base commit');
  });

  it('rejects invalid or unavailable branches before a project can be saved', async () => {
    for (const baseBranch of ['does-not-exist', 'invalid branch', '--help', 'main..release', 'bad\0branch', 'only-a-tag', 'origin/only-a-remote-tag']) {
      await expect(validateProjectWorktreeSettings({
        workingDirectory: repo, worktreeSettings: { enabled: true, baseBranch },
      })).rejects.toThrow('existing base branch');
    }
  });

  it('validates untrusted settings even when enabled is truthy', async () => {
    await expect(validateProjectWorktreeSettings({
      workingDirectory: repo, worktreeSettings: { enabled: 'true' } as unknown as ProjectWorktreeSettings,
    })).rejects.toThrow('Worktree settings');
  });
});
