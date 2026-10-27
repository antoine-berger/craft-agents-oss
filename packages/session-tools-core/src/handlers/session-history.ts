import type { SessionToolContext } from '../context.ts';
import type { SessionHistoryReadOptions, SessionHistorySearchOptions } from '../session-history-types.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export async function handleReadSession(ctx: SessionToolContext, args: SessionHistoryReadOptions): Promise<ToolResult> {
  if (!ctx.readSessionHistory) return errorResponse('read_session is not available in this context.');
  try {
    return successResponse(JSON.stringify(await ctx.readSessionHistory(args)));
  } catch {
    // Keep filesystem paths and provider internals out of tool errors.
    return errorResponse('Cannot read this chat in the current workspace, or its history changed. Retry without a cursor.');
  }
}

export async function handleSearchSessions(ctx: SessionToolContext, args: SessionHistorySearchOptions): Promise<ToolResult> {
  if (!ctx.searchSessionHistory) return errorResponse('search_sessions is not available in this context.');
  try {
    return successResponse(JSON.stringify(await ctx.searchSessionHistory(args)));
  } catch {
    return errorResponse('Cannot search chat history in the current workspace, or the history changed. Retry without a cursor.');
  }
}
