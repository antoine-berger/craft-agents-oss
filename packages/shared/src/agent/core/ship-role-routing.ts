/** Enforce Ship's provider split even when a resumed chat still holds an older skill. */
export type ShipRoleRouting =
  | { type: 'block'; reason: string; role: string }
  | { type: 'modify'; input: Record<string, unknown>; role: string }
  | { type: 'allow' };

// Agent's tool schema accepts aliases only; resolve them explicitly on the proxy connection.
export const SHIP_CLAUDE_MODEL_ENV = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5',
};

/** A declared role is a finite contract in the prompt, not an extra SDK tool argument. */
export const SHIP_REVIEWER_ROLES = ['factcheck', 'omissions', 'bugs', 'comments', 'light', 'external-factcheck', 'performance', 'e2e'] as const;
export type ShipReviewerRole = typeof SHIP_REVIEWER_ROLES[number];
export const SHIP_NATIVE_ROLE_MODELS = {
  'external-factcheck': { model: 'opus', role: 'ship-factchecker' },
  performance: { model: 'opus', role: 'ship-perf-reviewer' },
  e2e: { model: 'sonnet', role: 'ship-e2e' },
} as const;

export function declaredShipRole(prompt: string): ShipReviewerRole | 'invalid' | undefined {
  const firstLine = prompt.trimStart().split(/\r?\n/, 1)[0] ?? '';
  if (!/^Ship-Role\s*:/i.test(firstLine)) return;
  const value = /^Ship-Role: ([a-z0-9-]+)$/.exec(firstLine)?.[1];
  return SHIP_REVIEWER_ROLES.includes(value as ShipReviewerRole) ? value as ShipReviewerRole : 'invalid';
}

const CODEX_ROLES = [
  ['factcheck', /\b(?:codex[-_ ]factchecker|code[-/ ]docs? (?:checker|fact.?check(?:er)?)|code[-/ ]doc fact.?check(?:er)?|code[- ](?:checker|fact.?check(?:er)?))\b/i],
  ['omissions', /\b(?:codex[-_ ]omissions|plan[-_ ]omissions|omissions? (?:checker|reviewer|review)|omissions?)\b/i],
  ['light', /\b(?:codex[-_ ]light|light[- ](?:change|case)?\s*review(?:er)?)\b/i],
  ['comments', /\b(?:codex[-_ ]comments|comments?[-_ ](?:review(?:er)?|checker)|review\s+(?:r\d+\s+)?comments?)\b/i],
  ['bugs', /\b(?:astra|bugs?[-/ ]security|bugs?[-_ ]review(?:er)?|correctness[-/ ]security|review\s+(?:r\d+\s+)?bugs?)\b/i],
] as const;

export function routeShipReviewer(toolName: string, input: Record<string, unknown>, workspaceRoot: string, shipWorkingDirectory = false, cliProxyConnection = false): ShipRoleRouting {
  if (!['Agent', 'Task'].includes(toolName) || typeof input.prompt !== 'string') return { type: 'allow' };
  const subtype = typeof input.subagent_type === 'string' ? input.subagent_type : '';
  const description = typeof input.description === 'string' ? input.description : '';
  const prompt = input.prompt;
  const declaredRole = declaredShipRole(prompt);
  const explicitActor = prompt.match(/(?:^|\n)\s*["']?actor["']?\s*[:=]\s*["']?([\w-]+)/i)?.[1];
  const inShip = declaredRole !== undefined || shipWorkingDirectory || /^ship-(?:factchecker|perf-reviewer|e2e)$/.test(subtype)
    || /(?:\.context\/ship\/|\bPLAN_DIR\b|["']?gate["']?\s*[:=]\s*["']?(?:g1|review|e2e)\b)/i.test(prompt);
  if (!inShip) return { type: 'allow' };

  // Role declarations, not quoted findings or later rubric text, decide the reviewer identity.
  const identity = [subtype, explicitActor ?? '', description, prompt.split('\n')[0]].join(' ');
  const helper = `${workspaceRoot}/skills/ship-plan/scripts/codex-review.ts`;
  const refresh = `The owner requires Conductor's Claude/Codex split through CLIProxyAPI, including resumed chats. Read ${workspaceRoot}/skills/ship-plan/SKILL.md and ${workspaceRoot}/skills/ship/SKILL.md from disk; cached skill text may be stale. Preserve this chat, worktree, PR, owner approvals and current round. Do not restart the workflow, redo completed checks, create chats or relabel an old Claude verdict as Codex.`;

  if (declaredRole === 'invalid') return { type: 'block', role: 'invalid', reason: `Use exactly one first-line Ship-Role: ${SHIP_REVIEWER_ROLES.join('|')} declaration. Unknown roles cannot inherit the parent model.` };
  if (declaredRole !== undefined) {
    if (declaredRole in SHIP_NATIVE_ROLE_MODELS) {
      const native = SHIP_NATIVE_ROLE_MODELS[declaredRole as keyof typeof SHIP_NATIVE_ROLE_MODELS];
      if (!cliProxyConnection) return { type: 'block', role: native.role, reason: 'Ship reviewers require CLIProxyAPI. Select the Claude · Account pool connection for this chat before running this role; direct Claude credentials cannot run Ship reviewers.' };
      if (declaredRole === 'e2e' && input.resume) return { type: 'block', role: native.role, reason: `${refresh} E2E requires a fresh independent Agent with model="sonnet" through CLIProxyAPI.` };
      return input.model === native.model ? { type: 'allow' } : { type: 'modify', input: { ...input, model: native.model }, role: native.role };
    }
    return { type: 'block', role: declaredRole, reason: `${refresh} Run this declared Codex role with /home/craft/.bun/bin/bun ${helper} --role ${declaredRole} --round <current-round> --key <TICKET>-${declaredRole}-<batch> --input <input-file>. Keep the existing Codex thread on rechecks. Native Claude cannot execute this role.` };
  }

  let nativeModel: string | undefined;
  let nativeRole: string | undefined;
  if (/\b(?:ship[-_ ]e2e|e2e (?:prover|review|verification)|(?:independent|local) e2e|e2e[-_ ]prover)\b/i.test(identity)) {
    nativeModel = 'sonnet';
    nativeRole = 'ship-e2e';
    if (input.resume) return { type: 'block', role: nativeRole, reason: `${refresh} This E2E round requires a fresh independent Agent with model="sonnet" (pinned to claude-sonnet-5-5 on CLIProxyAPI), not an older Opus agent resumed by ID.` };
  } else if (/\b(?:ship[-_ ]perf[-_ ]reviewer|perf(?:ormance)?(?:[-/ ](?:production|review(?:er)?)| and production)|production (?:review(?:er)?|risk)|review\s+(?:r\d+\s+)?production)\b/i.test(identity)) {
    nativeModel = 'opus';
    nativeRole = 'ship-perf-reviewer';
  } else if (/\b(?:ship[-_ ]factchecker|external[-_ ]factchecker|external (?:checker|fact.?check(?:er)?)|prod[-/ ]ticket[-/ ]vendor)\b/i.test(identity)) {
    nativeModel = 'opus';
    nativeRole = 'ship-factchecker';
  }
  if (nativeModel && nativeRole) {
    if (!cliProxyConnection) return { type: 'block', role: nativeRole, reason: 'Ship reviewers require CLIProxyAPI. Select the Claude · Account pool connection for this chat before running this role; direct Claude credentials cannot run Ship reviewers.' };
    return input.model === nativeModel ? { type: 'allow' } : { type: 'modify', input: { ...input, model: nativeModel }, role: nativeRole };
  }
  const matches = CODEX_ROLES.filter(([, pattern]) => pattern.test(identity));
  if (matches.length === 1) {
    const role = matches[0]![0];
    return { type: 'block', role, reason: `${refresh} This pending ${role} role must run on Codex, not the Claude Agent tool. Write neutral inputs and run /home/craft/.bun/bin/bun ${helper} --role ${role} --round <current-round> --key <TICKET>-${role}-<batch> --input <input-file>. Reuse its Codex thread on rechecks. If this is the first Codex call after an old Claude round, disclose that migration and use --fresh with the actual current round and the prior own report. The helper fixes the model/effort and uses only CLIProxyAPI. Keep shadows off. Collect its actual result; no native-Claude fallback.` };
  }
  if (matches.length > 1 || /\b(?:reviewer|fact.?check(?:er)?|prover)\b/i.test(identity)) {
    return { type: 'block', role: 'ambiguous', reason: `${refresh} Specify one exact Ship reviewer role. Code/doc factcheck, omissions, bugs, comments and light reviews use the Codex helper. Only external factcheck/performance use native Opus; E2E uses native Sonnet. Do not combine providers in one inherited Claude Agent.` };
  }
  return { type: 'allow' };
}
