import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupModeState, initializeModeState, setGuardedModeActiveResolver, type PermissionMode } from '../../mode-manager.ts';
import { permissionsConfigCache } from '../../permissions-config.ts';
import { applyGuardedModeCheck, type GuardedModeCall } from '../guarded-mode.ts';
import { runPreToolUseChecks, type PreToolUseInput } from '../pre-tool-use.ts';
import { PrerequisiteManager } from '../prerequisite-manager.ts';

const SESSION = 'claude-ai-mcp-provenance';
const SERVER = 'claude_ai_Example';
const originalConfigDir = process.env.CRAFT_CONFIG_DIR;
let root: string;
let workspaceRootPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-ai-mcp-provenance-'));
  const configDir = join(root, 'config');
  workspaceRootPath = join(root, 'workspace');
  mkdirSync(workspaceRootPath);
  mkdirSync(join(configDir, 'permissions'), { recursive: true });
  writeFileSync(join(configDir, 'permissions', 'default.json'), JSON.stringify({
    version: '2026-10-25',
    allowedBashPatterns: [],
    allowedMcpPatterns: ['get', 'list', 'search'],
    allowedApiEndpoints: [],
    allowedWritePaths: [],
  }));
  process.env.CRAFT_CONFIG_DIR = configDir;
  permissionsConfigCache.clear();
  cleanupModeState(SESSION);
  setGuardedModeActiveResolver(() => true);
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CRAFT_CONFIG_DIR;
  else process.env.CRAFT_CONFIG_DIR = originalConfigDir;
  permissionsConfigCache.clear();
  cleanupModeState(SESSION);
  setGuardedModeActiveResolver(null);
  rmSync(root, { recursive: true, force: true });
});

function input(mode: PermissionMode, tool = 'search'): PreToolUseInput {
  initializeModeState(SESSION, mode);
  return {
    toolName: `mcp__${SERVER}__${tool}`,
    input: {},
    sessionId: SESSION,
    permissionMode: mode,
    workspaceRootPath,
    workspaceId: 'workspace',
    activeSourceSlugs: [],
    allSourceSlugs: [],
    mcpServer: { name: SERVER, source: 'claudeai' },
    hasSourceActivation: true,
    permissionManager: {
      isCommandWhitelisted: () => false,
      getBaseCommand: command => command,
      isDomainWhitelisted: () => false,
    },
  };
}

describe('Claude.ai MCP provenance in the tool permission pipeline', () => {
  for (const mode of ['safe', 'ask', 'allow-all'] as const) {
    it(`allows native read tools without a Craft source in ${mode} mode`, () => {
      const ctx = input(mode);
      expect(runPreToolUseChecks(ctx)).toEqual({ type: 'allow' });
      expect(ctx.activeSourceSlugs).toEqual([]);
      expect(ctx.allSourceSlugs).toEqual([]);
    });
  }

  it('uses provenance rather than requiring a particular server-name prefix', () => {
    const ctx = input('allow-all');
    ctx.toolName = 'mcp__display_name__search';
    ctx.mcpServer = { name: 'Display name', source: 'claudeai' };
    expect(runPreToolUseChecks(ctx)).toEqual({ type: 'allow' });
  });

  for (const source of [undefined, 'sdk', 'user', 'project', 'local', 'plugin', 'dynamic', 'unknown']) {
    it(`does not trust a claude_ai name with ${source ?? 'missing'} provenance`, () => {
      const ctx = input('allow-all');
      ctx.mcpServer = source === undefined ? undefined : { name: SERVER, source };
      expect(runPreToolUseChecks(ctx)).toEqual({
        type: 'source_activation_needed', sourceSlug: SERVER, sourceExists: false,
      });
    });
  }

  it('does not accept provenance forged inside the model-provided tool arguments', () => {
    const ctx = input('allow-all');
    ctx.mcpServer = undefined;
    ctx.input = { mcp_server: { name: SERVER, source: 'claudeai' } };
    expect(runPreToolUseChecks(ctx).type).toBe('source_activation_needed');
  });

  it('still blocks native mutations in Explore mode', () => {
    expect(runPreToolUseChecks(input('safe', 'create_record'))).toMatchObject({ type: 'block' });
  });

  it('still asks permission for native mutations in Ask mode', () => {
    expect(runPreToolUseChecks(input('ask', 'create_record'))).toMatchObject({
      type: 'prompt', promptType: 'mcp_mutation', command: `mcp__${SERVER}__create_record`,
    });
  });

  it('still sends native mutations through the Guarded-mode risk check', async () => {
    const ctx = input('guarded', 'create_record');
    const base = runPreToolUseChecks(ctx);
    expect(base.type).toBe('allow');
    const checked: GuardedModeCall[] = [];
    const result = await applyGuardedModeCheck(base, ctx, {
      isActive: () => true,
      check: async call => { checked.push(call); return { risks: ['external'] }; },
    });
    expect(checked).toHaveLength(1);
    expect(checked[0]?.toolName).toBe(ctx.toolName);
    expect(result).toMatchObject({ type: 'prompt', promptType: 'mcp_mutation' });
  });

  it('falls back to Ask for native mutations when the Guarded check is unavailable', () => {
    setGuardedModeActiveResolver(() => false);
    expect(runPreToolUseChecks(input('guarded', 'create_record'))).toMatchObject({
      type: 'prompt', promptType: 'mcp_mutation',
    });
  });

  it('preserves activation for an inactive Craft source', () => {
    const ctx = input('allow-all');
    ctx.toolName = 'mcp__craft_source__search';
    ctx.mcpServer = { name: 'craft_source', source: 'sdk' };
    ctx.allSourceSlugs = ['craft_source'];
    expect(runPreToolUseChecks(ctx)).toEqual({
      type: 'source_activation_needed', sourceSlug: 'craft_source', sourceExists: true,
    });
  });

  it('still calls the prerequisite manager after the activation step', () => {
    const ctx = input('allow-all');
    ctx.prerequisiteManager = {
      checkPrerequisites: () => ({ allowed: false, blockReason: 'Prerequisite still required' }),
      checkBashPrerequisites: () => ({ allowed: true }),
    };
    expect(runPreToolUseChecks(ctx)).toEqual({
      type: 'block', reason: 'Prerequisite still required', source: 'prerequisite',
    });
  });

  it('does not require the guide of a colliding Craft source for a native connector', () => {
    const guideFolder = join(workspaceRootPath, 'sources', SERVER);
    mkdirSync(guideFolder, { recursive: true });
    writeFileSync(join(guideFolder, 'guide.md'), 'Unrelated Craft source guide');
    const ctx = input('allow-all');
    ctx.prerequisiteManager = new PrerequisiteManager({ workspaceRootPath });
    expect(runPreToolUseChecks(ctx)).toEqual({ type: 'allow' });
  });

  it('still requires a Craft source guide with SDK-local provenance', () => {
    const guideFolder = join(workspaceRootPath, 'sources', SERVER);
    mkdirSync(guideFolder, { recursive: true });
    writeFileSync(join(guideFolder, 'guide.md'), 'Craft source guide');
    const ctx = input('allow-all');
    ctx.activeSourceSlugs = [SERVER];
    ctx.mcpServer = { name: SERVER, source: 'sdk' };
    ctx.prerequisiteManager = new PrerequisiteManager({ workspaceRootPath });
    const result = runPreToolUseChecks(ctx);
    expect(result.type).toBe('block');
    if (result.type === 'block') expect(result.reason).toContain('source guide');
  });

  it('still requires pending skill instructions for native connectors', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath });
    manager.registerSkillPrerequisites([join(workspaceRootPath, 'skills', 'review', 'SKILL.md')]);
    const ctx = input('allow-all');
    ctx.prerequisiteManager = manager;
    const result = runPreToolUseChecks(ctx);
    expect(result.type).toBe('block');
    if (result.type === 'block') expect(result.reason).toContain('skill instruction files');
  });

  it('does not skip API source guides when MCP provenance is present', () => {
    const guideFolder = join(workspaceRootPath, 'sources', SERVER);
    mkdirSync(guideFolder, { recursive: true });
    writeFileSync(join(guideFolder, 'guide.md'), 'API source guide');
    const ctx = input('allow-all');
    ctx.toolName = `api_${SERVER}`;
    ctx.prerequisiteManager = new PrerequisiteManager({ workspaceRootPath });
    const result = runPreToolUseChecks(ctx);
    expect(result.type).toBe('block');
    if (result.type === 'block') expect(result.reason).toContain('source guide');
  });
});
