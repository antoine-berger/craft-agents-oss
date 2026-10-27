import { afterEach, describe, expect, it } from 'bun:test';
import type { SessionToolContext } from '@craft-agent/session-tools-core';
import { attachSessionSelfManagementBindings } from '../session-self-management-bindings';
import { registerSessionScopedToolCallbacks, mergeSessionScopedToolCallbacks, unregisterSessionScopedToolCallbacks } from '../session-scoped-tool-callback-registry';

const sessionId = 'synthetic-history-bindings';
afterEach(() => unregisterSessionScopedToolCallbacks(sessionId));

describe('history callback bindings shared by Claude and Pi', () => {
  it('resolves caller-bound history callbacks lazily, including late replacements', async () => {
    const context = { sessionId } as SessionToolContext;
    attachSessionSelfManagementBindings(context, sessionId);
    expect(context.readSessionHistory).toBeUndefined();
    expect(context.searchSessionHistory).toBeUndefined();
    const calls: string[] = [];
    registerSessionScopedToolCallbacks(sessionId, {
      readSessionHistoryFn: async options => {
        calls.push(`read:${options.sessionId}`);
        return { sessionId: options.sessionId, warning: 'untrusted', messages: [], omittedRecords: 0 };
      },
      searchSessionHistoryFn: async options => {
        calls.push(`search:${options.query}`);
        return { warning: 'untrusted', matches: [], omittedRecords: 0 };
      },
    });
    await context.readSessionHistory!({ sessionId: 'another-chat' });
    await context.searchSessionHistory!({ query: 'literal query' });
    mergeSessionScopedToolCallbacks(sessionId, {
      readSessionHistoryFn: async options => {
        calls.push('replacement');
        return { sessionId: options.sessionId, warning: 'untrusted', messages: [], omittedRecords: 0 };
      },
    });
    await context.readSessionHistory!({ sessionId: 'another-chat' });
    expect(calls).toEqual(['read:another-chat', 'search:literal query', 'replacement']);
    unregisterSessionScopedToolCallbacks(sessionId);
    expect(context.readSessionHistory).toBeUndefined();
  });
});
