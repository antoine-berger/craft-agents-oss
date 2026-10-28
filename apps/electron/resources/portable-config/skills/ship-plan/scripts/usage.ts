import { randomUUID } from 'node:crypto';

export interface ReviewerUsageRecord {
  version: 1;
  id: string;
  role: string;
  requestedModel: string;
  servedModel: string | null;
  provider: 'CLIProxyAPI';
  account: null;
  accountAttribution: 'unknown';
  effort: string;
  round: number;
  startedAt: number;
  durationMs: number;
  status: 'completed' | 'failed';
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function model(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,99}$/.test(value) ? value : null;
}

/** Only provider/CLI event fields are observed. Prompt, output text and credentials are never copied. */
export function reviewerUsage(input: {
  role: string; requestedModel: string; effort: string; round: number;
  startedAt: number; finishedAt: number; status: 'completed' | 'failed'; events: string;
}): ReviewerUsageRecord {
  const events = input.events.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const turns = events.filter(event => event?.type === 'turn.completed');
  const responses = events.filter(event => event?.type === 'response.completed' && event.response);
  const usages = turns.length ? turns.map(event => event.usage) : responses.map(event => event.response.usage);
  const sum = (field: 'input_tokens' | 'output_tokens' | 'cached_input_tokens') => {
    if (!usages.length) return null;
    const values = usages.map(usage => count(field === 'cached_input_tokens' ? usage?.cached_input_tokens ?? usage?.input_tokens_details?.cached_tokens : usage?.[field]));
    if (values.some(value => value === null)) return null;
    const total = (values as number[]).reduce((total, value) => total + value, 0);
    return Number.isSafeInteger(total) ? total : null;
  };
  const served = [...new Set(responses.map(event => model(event.response.model)).filter((value): value is string => value !== null))];
  return {
    version: 1, id: randomUUID(), role: input.role, requestedModel: input.requestedModel,
    servedModel: served.length === 1 ? served[0]! : null,
    provider: 'CLIProxyAPI', account: null, accountAttribution: 'unknown', effort: input.effort,
    round: input.round, startedAt: input.startedAt, durationMs: Math.max(0, input.finishedAt - input.startedAt), status: input.status,
    inputTokens: sum('input_tokens'), outputTokens: sum('output_tokens'), cacheReadTokens: sum('cached_input_tokens'),
  };
}
