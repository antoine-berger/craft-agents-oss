/**
 * Session Content Search Service
 *
 * Uses ripgrep to search session content (JSONL files).
 * Returns matches with session IDs and context snippets.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolveBackendHostTooling } from '@craft-agent/shared/agent/backend';
import { createScopedLogger, CONSOLE_LOGGER, type PlatformServices, type Logger } from '../runtime/platform';
import type { SessionSearchResponse, SessionSearchStatus } from '@craft-agent/shared/protocol';

/**
 * Thrown when the search service cannot run (e.g. ripgrep binary not found).
 * Clients should catch this and show an "unavailable" state instead of "0 results".
 */
export class SearchUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SearchUnavailableError';
  }
}

const searches = new Map<string, { clientId: string; searchId: string; cancel(): void }>();

/** A query in one window must not cancel another window's search. */
export function cancelSessionSearchesForClient(clientId: string): void {
  for (const search of searches.values()) if (search.clientId === clientId) search.cancel();
}

export function cancelSessionSearchRequest(clientId: string, workspaceId: string, searchId: string): void {
  const search = searches.get(JSON.stringify([clientId, workspaceId]));
  if (search?.searchId === searchId) search.cancel();
}

// Module-level platform ref — set once during init via setSearchPlatform()
let _platform: PlatformServices | null = null;

// Scoped loggers — upgraded from console fallback when setSearchPlatform() is called
let handlerLog: Logger = createScopedLogger(CONSOLE_LOGGER, 'handler');
let searchLog: Logger = createScopedLogger(CONSOLE_LOGGER, 'search');

export function setSearchPlatform(platform: PlatformServices): void {
  _platform = platform;
  handlerLog = createScopedLogger(platform.logger, 'handler');
  searchLog = createScopedLogger(platform.logger, 'search');
}

/**
 * Search result for a single match
 */
export interface SearchMatch {
  /** Session ID (extracted from file path) */
  sessionId: string;
  /** Line number in the JSONL file */
  lineNumber: number;
  /** The matched text snippet with context */
  snippet: string;
  /** The raw matched text (without context) */
  matchText?: string;
}

/**
 * Aggregated search results for a session
 */
export interface SessionSearchResult {
  sessionId: string;
  /** Number of matches found in this session */
  matchCount: number;
  /** First few matches with context */
  matches: SearchMatch[];
}

/**
 * Options for session search
 */
export interface SearchOptions {
  /** Maximum time to wait for search (ms). Default: 5000 */
  timeout?: number;
  /** Maximum matches per session. Default: 3 */
  maxMatchesPerSession?: number;
  /** Maximum sessions with extracted snippets; all matching sessions are counted. */
  maxSessions?: number;
  /** Case insensitive search. Default: true */
  ignoreCase?: boolean;
  /** Search ID for correlating logs across stages */
  searchId?: string;
  scope?: { clientId: string; workspaceId: string };
  /** Filter before counting/snippet allocation, including hidden imported histories. */
  allowedSessionIds?: ReadonlySet<string>;
}

/**
 * Get the path to the ripgrep binary.
 * Path discovery is delegated to backend runtime tooling resolvers.
 */
function getRipgrepPath(): string | undefined {
  if (!_platform) throw new Error('setSearchPlatform() must be called before search');
  const { ripgrepPath } = resolveBackendHostTooling({
    hostRuntime: {
      appRootPath: _platform.appRootPath,
      resourcesPath: _platform.resourcesPath,
      isPackaged: _platform.isPackaged,
    },
  });
  return ripgrepPath;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract a snippet from raw JSON line without full parsing.
 * Uses regex to extract content field and a window around the match.
 * This avoids expensive JSON.parse() on large message lines.
 */
function extractSnippetFast(rawLine: string, matchText: string, maxLength = 150): string {
  try {
    // Extract the "content" field value using regex
    // Handles both string content and the start of array content
    const contentMatch = rawLine.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);

    if (contentMatch) {
      // Simple string content - unescape and extract window around match
      const content = contentMatch[1]
        .replace(/\\n/g, ' ')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');

      const lowerContent = content.toLowerCase();
      const lowerMatch = matchText.toLowerCase();
      const matchPos = lowerContent.indexOf(lowerMatch);

      if (matchPos >= 0) {
        const halfLength = Math.floor(maxLength / 2);
        const start = Math.max(0, matchPos - halfLength);
        const end = Math.min(content.length, start + maxLength);

        let snippet = content.slice(start, end);
        if (start > 0) snippet = '...' + snippet;
        if (end < content.length) snippet = snippet + '...';
        return snippet;
      }

      // Match not in content field, return start of content
      if (content.length > maxLength) {
        return content.slice(0, maxLength) + '...';
      }
      return content;
    }

    // Content might be an array (Claude format) - extract first text block
    const textBlockMatch = rawLine.match(/"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (textBlockMatch) {
      const text = textBlockMatch[1]
        .replace(/\\n/g, ' ')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');

      if (text.length > maxLength) {
        return text.slice(0, maxLength) + '...';
      }
      return text;
    }

    // Fallback: extract a window around the match from raw line
    const lowerLine = rawLine.toLowerCase();
    const lowerMatch = matchText.toLowerCase();
    const matchPos = lowerLine.indexOf(lowerMatch);

    if (matchPos >= 0) {
      const halfLength = Math.floor(maxLength / 2);
      const start = Math.max(0, matchPos - halfLength);
      const end = Math.min(rawLine.length, start + maxLength);
      let snippet = rawLine.slice(start, end).replace(/\\n/g, ' ');
      if (start > 0) snippet = '...' + snippet;
      if (end < rawLine.length) snippet = snippet + '...';
      return snippet;
    }

    return '';
  } catch {
    return '';
  }
}

/**
 * Search session content using ripgrep.
 *
 * @param query - Search query (plain text, will be escaped)
 * @param sessionsDir - Path to the sessions directory
 * @param options - Search options
 * @returns Promise resolving to array of session search results
 */
export async function searchSessions(query: string, sessionsDir: string, options: SearchOptions = {}): Promise<SessionSearchResult[]> {
  const response = await searchSessionsDetailed(query, sessionsDir, options);
  if (response.status === 'unavailable') throw new SearchUnavailableError('Session content search is unavailable.');
  return response.results;
}

/** A status envelope distinguishes an empty answer from interrupted or unavailable search. */
export async function searchSessionsDetailed(
  query: string,
  sessionsDir: string,
  options: SearchOptions = {},
): Promise<SessionSearchResponse> {
  const { timeout = 5000, maxMatchesPerSession = 3, maxSessions = 50, ignoreCase = true,
    searchId = Date.now().toString(36), scope, allowedSessionIds } = options;
  const empty = (status: SessionSearchStatus): SessionSearchResponse => ({ searchId, results: [], status });
  if (!query.trim()) return empty('complete');
  let rgPath: string | undefined;
  try { rgPath = getRipgrepPath(); } catch { return empty('unavailable'); }
  if (!rgPath || !existsSync(rgPath)) return empty('unavailable');
  if (!existsSync(sessionsDir)) return empty('complete');
  const key = scope ? JSON.stringify([scope.clientId, scope.workspaceId]) : undefined;
  if (key) searches.get(key)?.cancel();
  const startTime = Date.now();
  return new Promise(resolve => {
    const results = new Map<string, SessionSearchResult>();
    let buffer = '';
    let status: SessionSearchStatus = 'complete';
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const args = ['--json', '-g', '**/session.jsonl'];
    if (ignoreCase) args.push('-i');
    const escapedQuery = escapeRegex(query);
    args.push('-e', `"type":"(user|assistant)".*${escapedQuery}|${escapedQuery}.*"type":"(user|assistant)"`, sessionsDir);
    const rg = spawn(rgPath!, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const active = { clientId: scope?.clientId ?? '', searchId, cancel: () => stop('cancelled') };
    if (key) searches.set(key, active);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (key && searches.get(key) === active) searches.delete(key);
      const resultArray = [...results.values()].sort((a, b) => b.matchCount - a.matchCount);
      searchLog.info('ripgrep:complete', { searchId, status, durationMs: Date.now() - startTime, totalSessions: results.size });
      resolve({ searchId, results: resultArray, status });
    };
    function stop(reason: SessionSearchStatus) {
      if (settled || status === 'cancelled' || status === 'timed_out') return;
      status = reason;
      rg.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
      // A stuck child cannot hold the RPC indefinitely after cancellation/disconnect.
      killTimer = setTimeout(() => { rg.kill('SIGKILL'); finish(); }, 500);
    }
    const timer = setTimeout(() => stop('timed_out'), timeout);
    const consume = (line: string) => {
      if (!line.trim()) return;
      try {
        const result = JSON.parse(line);
        if (result.type !== 'match') return;
        const data = result.data;
        const pathParts = data.path?.text?.split(/[/\\]/);
        const jsonlIndex = pathParts?.lastIndexOf('session.jsonl');
        const sessionId = jsonlIndex > 0 ? pathParts[jsonlIndex - 1] : undefined;
        if (!sessionId || data.line_number === 1 || (allowedSessionIds && !allowedSessionIds.has(sessionId))) return;
        const rawLine = data.lines?.text || '';
        if (rawLine.includes('"isIntermediate":true') || rawLine.includes('base64')) return;
        let entry = results.get(sessionId);
        if (!entry) { entry = { sessionId, matchCount: 0, matches: [] }; results.set(sessionId, entry); }
        entry.matchCount += data.submatches?.length || 1;
        if (results.size <= maxSessions && entry.matches.length < maxMatchesPerSession) {
          const matchText = data.submatches?.[0]?.match?.text || query;
          entry.matches.push({ sessionId, lineNumber: data.line_number,
            snippet: extractSnippetFast(rawLine, matchText), matchText });
        }
      } catch { if (status === 'complete') status = 'partial'; }
    };
    rg.stdout.setEncoding('utf8');
    rg.stdout.on('data', (chunk: string) => {
      if (settled) return;
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) consume(line);
    });
    rg.stderr.on('data', () => {});
    rg.on('close', code => {
      if (settled) return;
      if (buffer) consume(buffer);
      if (status === 'complete' && code !== 0 && code !== 1) status = results.size ? 'partial' : 'unavailable';
      finish();
    });
    rg.on('error', () => { if (status === 'complete') status = results.size ? 'partial' : 'unavailable'; finish(); });
  });
}
