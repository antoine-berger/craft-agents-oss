import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupI18n } from '../../i18n/index.ts';
import { createProject, getProjectPath, loadProjectConfig, saveProjectConfig, updateProject } from '../storage.ts';
import type { ProjectWorktreeSettings } from '../types.ts';

let root: string;
let workspace: string;
let repo: string;

beforeAll(() => { setupI18n(); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'project-worktree-settings-'));
  workspace = join(root, 'workspace');
  repo = join(root, 'repository');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('project worktree settings persistence', () => {
  it('leaves existing projects without a policy unchanged and allows shared repositories', () => {
    const project = createProject(workspace, { name: 'Checkout redesign', workingDirectory: repo });
    const second = createProject(workspace, { name: 'Search improvements', workingDirectory: repo });
    expect(loadProjectConfig(workspace, project.slug)?.worktreeSettings).toBeUndefined();
    expect(loadProjectConfig(workspace, second.slug)?.workingDirectory).toBe(repo);
    expect(second.id).not.toBe(project.id);
  });

  it('round-trips the policy, normalizes the base branch and defaults cleanup to off', () => {
    const project = createProject(workspace, {
      name: 'Checkout redesign', workingDirectory: repo,
      worktreeSettings: { enabled: true, baseBranch: '  origin/main  ' },
    });
    expect(project.worktreeSettings).toEqual({ enabled: true, baseBranch: 'origin/main', cleanupOnArchive: false });
    expect(loadProjectConfig(workspace, project.slug)?.worktreeSettings).toEqual(project.worktreeSettings);

    updateProject(workspace, project.slug, { name: 'Checkout launch' });
    expect(loadProjectConfig(workspace, project.slug)?.worktreeSettings).toEqual(project.worktreeSettings);

    updateProject(workspace, project.slug, { worktreeSettings: { enabled: true, baseBranch: ' ', cleanupOnArchive: true } });
    expect(loadProjectConfig(workspace, project.slug)?.worktreeSettings).toEqual({ enabled: true, cleanupOnArchive: true });
  });

  it('rejects an enabled policy with no repository before creating any files', () => {
    expect(() => createProject(workspace, {
      name: 'Missing repo', worktreeSettings: { enabled: true },
    })).toThrow('Choose a repository folder');
    expect(existsSync(workspace)).toBe(false);
  });

  it('preserves the saved project when an update would clear its required repository', () => {
    const project = createProject(workspace, {
      name: 'Safe update', workingDirectory: repo, worktreeSettings: { enabled: true },
    });
    const path = join(getProjectPath(workspace, project.slug), 'config.json');
    const before = readFileSync(path, 'utf8');
    expect(() => updateProject(workspace, project.slug, { workingDirectory: '' })).toThrow('Choose a repository folder');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(() => saveProjectConfig(workspace, { ...project, workingDirectory: undefined })).toThrow('Choose a repository folder');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('can turn the policy off and clear the repository with a JSON-safe patch', () => {
    const project = createProject(workspace, {
      name: 'Research', workingDirectory: repo, worktreeSettings: { enabled: true, baseBranch: 'main' },
    });
    const patch = JSON.parse(JSON.stringify({ workingDirectory: '', worktreeSettings: { enabled: false } }));
    const updated = updateProject(workspace, project.slug, patch);
    expect(updated.workingDirectory).toBeUndefined();
    expect(updated.worktreeSettings).toEqual({ enabled: false, baseBranch: undefined, cleanupOnArchive: false });
    expect(loadProjectConfig(workspace, project.slug)?.workingDirectory).toBeUndefined();
  });

  it('rejects malformed RPC values instead of enabling worktrees through truthiness', () => {
    const project = createProject(workspace, { name: 'Schema validation', workingDirectory: repo });
    const path = join(getProjectPath(workspace, project.slug), 'config.json');
    const before = readFileSync(path, 'utf8');
    for (const settings of [
      null, [], true, {}, { enabled: 'false' }, { enabled: 1 },
      { enabled: true, baseBranch: false }, { enabled: true, cleanupOnArchive: 'yes' },
      { enabled: true, extraField: true },
    ]) {
      expect(() => updateProject(workspace, project.slug, {
        worktreeSettings: settings as unknown as ProjectWorktreeSettings,
      })).toThrow('Worktree settings');
      expect(readFileSync(path, 'utf8')).toBe(before);
    }
  });
});
