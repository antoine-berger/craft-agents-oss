import { describe, expect, it } from 'bun:test';
import type { SessionToolContext } from '../context';
import { ReadSessionSchema, SearchSessionsSchema, SESSION_TOOL_DEFS } from '../tool-defs';
import { SESSION_HISTORY_WARNING } from '../session-history-types';
import { handleReadSession, handleSearchSessions } from './session-history';

describe('read_session / search_sessions', () => {
  it('forwards bounded read/search arguments only to the caller-bound callbacks', async () => {
    const calls: unknown[] = [];
    const ctx = {
      sessionId: 'caller',
      readSessionHistory: async (options: unknown) => {
        calls.push(['read', options]);
        return { sessionId: 'other', warning: SESSION_HISTORY_WARNING, messages: [], omittedRecords: 0 };
      },
      searchSessionHistory: async (options: unknown) => {
        calls.push(['search', options]);
        return { warning: SESSION_HISTORY_WARNING, matches: [], omittedRecords: 0 };
      },
      sendAgentMessage: () => { throw new Error('Reading history must never send messages'); },
    } as unknown as SessionToolContext;
    const read = { sessionId: 'other', limit: 2, roles: ['user' as const], cursor: 'opaque' };
    const search = { query: 'literal [.*]', projectId: 'project', maxSnippetChars: 100 };
    expect((await handleReadSession(ctx, read)).isError).toBeFalsy();
    expect((await handleSearchSessions(ctx, search)).isError).toBeFalsy();
    expect(calls).toEqual([['read', read], ['search', search]]);
  });

  it('does not disclose filesystem paths or credentials in callback errors', async () => {
    const ctx = {
      readSessionHistory: async () => { throw new Error('/private/path SDK_TOKEN=secret'); },
      searchSessionHistory: async () => { throw new Error('/private/path SDK_TOKEN=secret'); },
    } as unknown as SessionToolContext;
    const read = await handleReadSession(ctx, { sessionId: 'other' });
    const search = await handleSearchSessions(ctx, { query: 'needle' });
    expect(read.isError).toBe(true);
    expect(search.isError).toBe(true);
    expect(JSON.stringify([read, search])).not.toMatch(/private\/path|SDK_TOKEN|secret/);
  });

  it('reports unavailable callbacks clearly', async () => {
    const ctx = {} as SessionToolContext;
    expect((await handleReadSession(ctx, { sessionId: 'other' })).isError).toBe(true);
    expect((await handleSearchSessions(ctx, { query: 'needle' })).isError).toBe(true);
  });

  it('registers both tools read-only in every profile and bounds their schemas', () => {
    for (const name of ['read_session', 'search_sessions']) {
      const def = SESSION_TOOL_DEFS.find(tool => tool.name === name);
      expect(def?.readOnly).toBe(true);
      expect(def?.safeMode).toBe('allow');
      expect(def?.description).toContain('UNTRUSTED');
    }
    expect(ReadSessionSchema.safeParse({ sessionId: 'other', limit: 51 }).success).toBe(false);
    expect(SearchSessionsSchema.safeParse({ query: '   ' }).success).toBe(false);
    expect(SearchSessionsSchema.safeParse({ query: 'x', roles: ['thinking'] }).success).toBe(false);
  });
});
