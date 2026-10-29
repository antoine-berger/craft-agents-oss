import type { Message } from '@craft-agent/core/types';

type SettlementOptions = {
  reason?: 'complete' | 'interrupted' | 'error' | 'timeout';
  activeToolUseIds?: ReadonlySet<string>;
  before?: number;
  rootToolUseId?: string;
};

/** Close missing foreground results without touching live background task trees. */
export function settleToolStatuses(messages: Message[], options: SettlementOptions = {}): Message[] {
  const byId = new Map(messages.filter(m => m.toolUseId).map(m => [m.toolUseId!, m]));
  const active = options.activeToolUseIds ?? new Set(messages
    .filter(m => m.isBackground && (m.taskId || m.shellId) && m.toolStatus !== 'completed' && m.toolStatus !== 'error')
    .map(m => m.toolUseId).filter((id): id is string => !!id));
  const ancestors = (message: Message): string[] => {
    const ids: string[] = [];
    let id = message.toolUseId;
    while (id && !ids.includes(id)) { ids.push(id); id = byId.get(id)?.parentToolUseId; }
    return ids;
  };
  let changed = false;
  const result = messages.map(message => {
    if (message.role !== 'tool' || message.toolStatus === 'completed' || message.toolStatus === 'error'
      || (options.before !== undefined && message.timestamp > options.before)) return message;
    const ids = ancestors(message);
    if (ids.some(id => active.has(id)) || (options.rootToolUseId && !ids.includes(options.rootToolUseId))) return message;
    changed = true;
    const failed = message.isError === true || (options.reason !== undefined && options.reason !== 'complete');
    return { ...message, toolStatus: failed ? 'error' as const : 'completed' as const,
      isError: failed, toolResult: message.toolResult ?? (failed ? 'Tool interrupted before a result was reported.' : 'No tool result was reported before this turn ended.') };
  });
  return changed ? result : messages;
}

/** Keep the task's terminal summary when a delayed launch/result payload arrives. */
export function mergeTerminalToolOutput(previous: string | undefined, incoming: string): string {
  if (!previous || incoming.includes(previous)) return incoming;
  if (!incoming || previous.includes(incoming)) return previous;
  const merged = `${previous}\n\nAdditional tool output:\n${incoming}`;
  return merged.length <= 200_000 ? merged : `${merged.slice(0, 200_000)}\n[Truncated for storage]`;
}
