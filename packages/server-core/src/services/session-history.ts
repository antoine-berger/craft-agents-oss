import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Stats } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { SESSION_HISTORY_WARNING } from '@craft-agent/session-tools-core';
import type {
  SessionHistoryMessage, SessionHistoryReadOptions, SessionHistoryReadResult,
  SessionHistoryRole, SessionHistorySearchOptions, SessionHistorySearchResult,
} from '@craft-agent/session-tools-core';

/** This catalog must be built by the manager from the invoking chat's workspace only. */
export interface SessionHistoryScope {
  workspaceId: string;
  workspaceRootPath: string;
  sessions: ReadonlyArray<{ id: string; name?: string; projectId?: string }>;
}

const CURSOR_SECRET = randomBytes(32);
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const SCAN_BYTES_PER_PAGE = 8 * 1024 * 1024;
const MAX_SESSIONS_PER_PAGE = 50;
const MAX_PAGE_CHARS = 48_000;
const CURSOR_TTL_MS = 30 * 60_000;
const VALID_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;

interface FileSnapshot { inode: string; size: number; modified: number }
interface HistoryCursor {
  version: 1;
  scope: string;
  filter: string;
  expires: number;
  sessionIndex: number;
  offset: number;
  file?: FileSnapshot;
  skipRecord?: boolean;
  catalogHash?: string;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error('Invalid history limit');
  return Math.min(value, max);
}

function normalizeRoles(roles?: SessionHistoryRole[]): SessionHistoryRole[] {
  const result = [...new Set(roles ?? ['user', 'assistant', 'tool'])].sort() as SessionHistoryRole[];
  if (!result.length || result.some(role => !['user', 'assistant', 'tool'].includes(role))) throw new Error('Invalid roles');
  return result;
}

function normalizeQuery(query: string | undefined, required = false): string {
  if (query !== undefined && (typeof query !== 'string' || query.length > 500)) throw new Error('Invalid query');
  const normalized = (query ?? '').trim().toLocaleLowerCase();
  if (required && !normalized) throw new Error('Search requires literal text');
  return normalized;
}

function cursorBinding(scope: SessionHistoryScope): string {
  return digest([scope.workspaceId, scope.workspaceRootPath]);
}

function decodeCursor(value: string | undefined, scope: SessionHistoryScope, filter: string): HistoryCursor {
  if (!value) return { version: 1, scope: cursorBinding(scope), filter, expires: Date.now() + CURSOR_TTL_MS, sessionIndex: 0, offset: 0 };
  if (value.length > 3000) throw new Error('Invalid history cursor');
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra) throw new Error('Invalid history cursor');
  const expected = createHmac('sha256', CURSOR_SECRET).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid history cursor');
  const cursor = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as HistoryCursor;
  if (cursor.version !== 1 || cursor.scope !== cursorBinding(scope) || cursor.filter !== filter || cursor.expires < Date.now()
    || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || !Number.isSafeInteger(cursor.sessionIndex) || cursor.sessionIndex < 0) {
    throw new Error('History cursor expired or belongs to another query');
  }
  return cursor;
}

function encodeCursor(cursor: HistoryCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${payload}.${createHmac('sha256', CURSOR_SECRET).update(payload).digest('base64url')}`;
}

function isContained(root: string, path: string): boolean {
  const pathRelative = relative(root, path);
  return pathRelative !== '' && !isAbsolute(pathRelative) && pathRelative !== '..' && !pathRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
}

async function openHistory(scope: SessionHistoryScope, sessionId: string): Promise<FileHandle> {
  if (!VALID_ID.test(sessionId) || !scope.sessions.some(session => session.id === sessionId)) throw new Error('Unknown session in this workspace');
  const workspace = await realpath(scope.workspaceRootPath);
  const sessions = await realpath(join(workspace, 'sessions'));
  const directory = await realpath(join(sessions, sessionId));
  const file = await realpath(join(directory, 'session.jsonl'));
  if (!isContained(workspace, sessions) || !isContained(sessions, directory) || !isContained(directory, file)) throw new Error('History path outside workspace');
  const handle = await open(file, 'r');
  try {
    // Check the opened file, rather than trusting a symlink checked before open.
    const [opened, current, canonicalFile] = await Promise.all([handle.stat(), stat(file), realpath(file)]);
    if (!opened.isFile() || opened.ino !== current.ino || opened.dev !== current.dev || canonicalFile !== file) throw new Error('History changed during open');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function fileSnapshot(info: Stats): FileSnapshot {
  return { inode: `${info.dev}:${info.ino}`, size: info.size, modified: info.mtimeMs };
}

function validateSnapshot(current: FileSnapshot, previous?: FileSnapshot): FileSnapshot {
  if (!previous) return current;
  // Appends are safe: retain the original upper bound. Atomic rewrites require a fresh query.
  if (current.inode !== previous.inode || current.size < previous.size
    || (current.size === previous.size && current.modified !== previous.modified)) throw new Error('History changed; restart pagination');
  return previous;
}

/** Read complete JSONL records with bounded memory; never collect the whole file. */
async function* records(handle: FileHandle, start: number, end: number, skipRecord = false): AsyncGenerator<{ value?: unknown; nextOffset: number; bytes: number; partial?: boolean }> {
  const buffer = Buffer.alloc(64 * 1024);
  let position = start;
  let recordStart = start;
  let fragments: Buffer[] = [];
  let bytes = 0;
  let oversized = skipRecord;
  while (position < end) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - position), position);
    if (!bytesRead) break;
    let segment = 0;
    for (let index = 0; index < bytesRead; index++) {
      if (buffer[index] !== 10) continue;
      const fragment = buffer.subarray(segment, index);
      bytes += fragment.length;
      if (!oversized && bytes <= MAX_RECORD_BYTES) fragments.push(Buffer.from(fragment));
      else { oversized = true; fragments = []; }
      const nextOffset = position + index + 1;
      let value: unknown;
      if (!oversized && bytes) {
        try { value = JSON.parse(Buffer.concat(fragments).toString('utf8')); } catch { /* Skip malformed crash tails. */ }
      }
      yield { value, nextOffset, bytes: nextOffset - recordStart };
      recordStart = nextOffset;
      fragments = [];
      bytes = 0;
      oversized = false;
      segment = index + 1;
    }
    const remainder = buffer.subarray(segment, bytesRead);
    bytes += remainder.length;
    if (!oversized && bytes <= MAX_RECORD_BYTES) fragments.push(Buffer.from(remainder));
    else { oversized = true; fragments = []; }
    position += bytesRead;
    if (position - start >= SCAN_BYTES_PER_PAGE && oversized) {
      yield { nextOffset: position, bytes: position - recordStart, partial: true };
      return;
    }
  }
  // The writer terminates canonical records with a newline. An incomplete tail is omitted.
  if (recordStart < end) yield { nextOffset: end, bytes: end - recordStart };
}

/** Redact credential-shaped content in historical prose and tool results as well as JSON. */
export function redactHistoryText(text: string): string {
  return text
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    // Only start at a key boundary and bound key-name fragments. Unbounded
    // fragments retry at every character of long tool output and become quadratic.
    .replace(/(^|[^\w-])((?:["']?)(?:[\w-]{0,128}(?:api[_-]?key|secret|password|credential|token|authorization|cookie|sdkSessionId|sdkCwd)[\w-]{0,128})(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1$2[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
}

function historicalMessage(value: unknown): SessionHistoryMessage | undefined {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const rawRole = record.type ?? record.role;
  const role = rawRole === 'tool_result' ? 'tool' : rawRole;
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') return;
  // Thinking, SDK/session headers, authentication requests and source configurations are never exposed.
  const text = typeof record.content === 'string' ? record.content : '';
  const result = role === 'tool' && typeof record.toolResult === 'string' ? record.toolResult : '';
  if (!text && !result) return;
  const sensitiveTool = role === 'tool' && /credential|oauth|auth_request|source_(?:test|credential)|secret|keychain/i.test(String(record.toolName ?? ''));
  return {
    id: typeof record.id === 'string' ? redactHistoryText(record.id).slice(0, 200) : 'unknown',
    role,
    text: sensitiveTool ? '[Credential-related tool content omitted]' : redactHistoryText(text + (result && result !== text ? `\n${result}` : '')),
    ...(typeof record.timestamp === 'number' && Number.isFinite(record.timestamp) ? { timestamp: record.timestamp } : {}),
    ...(role === 'tool' && typeof record.toolName === 'string' ? { toolName: redactHistoryText(record.toolName).slice(0, 120) } : {}),
    truncated: false,
    untrusted: true,
  };
}

function excerpt(message: SessionHistoryMessage, maxChars: number, query: string, snippet: boolean): SessionHistoryMessage {
  const match = snippet && query ? message.text.toLocaleLowerCase().indexOf(query) : 0;
  const start = Math.max(0, match - Math.floor(maxChars / 3));
  const available = Math.max(0, maxChars - (start ? 1 : 0) - (start + maxChars < message.text.length ? 1 : 0));
  const text = message.text.slice(start, start + available);
  return { ...message, text: `${start ? '…' : ''}${text}${start + maxChars < message.text.length ? '…' : ''}`.slice(0, maxChars), truncated: start > 0 || text.length < message.text.length };
}

interface ScanOptions { roles: SessionHistoryRole[]; query: string; limit: number; maxChars: number; snippet: boolean; byteBudget: number; charBudget?: number }
async function scanFile(handle: FileHandle, cursor: HistoryCursor, options: ScanOptions) {
  const snapshot = validateSnapshot(fileSnapshot(await handle.stat()), cursor.file);
  const messages: SessionHistoryMessage[] = [];
  let omittedRecords = 0;
  let scannedBytes = 0;
  let chars = 0;
  let offset = cursor.offset;
  let skipRecord = cursor.skipRecord;
  for await (const record of records(handle, offset, snapshot.size, skipRecord)) {
    const previousOffset = offset;
    offset = record.nextOffset;
    scannedBytes += record.bytes;
    skipRecord = record.partial || undefined;
    if (record.value === undefined && !record.partial) omittedRecords++;
    const message = historicalMessage(record.value);
    if (message && options.roles.includes(message.role) && (!options.query || message.text.toLocaleLowerCase().includes(options.query))) {
      const item = excerpt(message, options.maxChars, options.query, options.snippet);
      if (messages.length && chars + item.text.length > (options.charBudget ?? MAX_PAGE_CHARS)) { offset = previousOffset; skipRecord = undefined; break; }
      messages.push(item);
      chars += item.text.length;
    }
    if (messages.length >= options.limit || scannedBytes >= options.byteBudget) break;
  }
  validateSnapshot(fileSnapshot(await handle.stat()), snapshot);
  return { messages, omittedRecords, scannedBytes, offset, snapshot, skipRecord, done: offset >= snapshot.size };
}

export async function readSessionHistory(scope: SessionHistoryScope, options: SessionHistoryReadOptions): Promise<SessionHistoryReadResult> {
  const roles = normalizeRoles(options.roles);
  const query = normalizeQuery(options.query);
  const limit = boundedInteger(options.limit, 20, 50);
  const maxChars = boundedInteger(options.maxMessageChars, 4000, 12_000);
  const filter = digest(['read', options.sessionId, roles, query, maxChars]);
  const cursor = decodeCursor(options.cursor, scope, filter);
  const handle = await openHistory(scope, options.sessionId);
  try {
    const page = await scanFile(handle, cursor, { roles, query, limit, maxChars, snippet: false, byteBudget: SCAN_BYTES_PER_PAGE });
    return {
      sessionId: options.sessionId,
      warning: SESSION_HISTORY_WARNING,
      messages: page.messages,
      omittedRecords: page.omittedRecords,
      ...(!page.done ? { nextCursor: encodeCursor({ ...cursor, offset: page.offset, file: page.snapshot, skipRecord: page.skipRecord }) } : {}),
    };
  } finally { await handle.close(); }
}

export async function searchSessionHistory(scope: SessionHistoryScope, options: SessionHistorySearchOptions): Promise<SessionHistorySearchResult> {
  const roles = normalizeRoles(options.roles);
  const query = normalizeQuery(options.query, true);
  const maxChars = boundedInteger(options.maxSnippetChars, 500, 2000);
  const limit = boundedInteger(options.limit, 20, 50);
  const catalog = scope.sessions.filter(session => !options.projectId || session.projectId === options.projectId).slice().sort((a, b) => a.id.localeCompare(b.id));
  const filter = digest(['search', roles, query, options.projectId, maxChars]);
  const cursor = decodeCursor(options.cursor, scope, filter);
  const catalogHash = digest(catalog.map(session => [session.id, session.projectId]));
  if (cursor.catalogHash && cursor.catalogHash !== catalogHash) throw new Error('Session catalog changed; restart pagination');
  const matches: SessionHistorySearchResult['matches'] = [];
  let omittedRecords = 0;
  let scannedBytes = 0;
  let filesScanned = 0;
  let chars = 0;
  while (cursor.sessionIndex < catalog.length && filesScanned < MAX_SESSIONS_PER_PAGE && scannedBytes < SCAN_BYTES_PER_PAGE && matches.length < limit) {
    const session = catalog[cursor.sessionIndex]!;
    const handle = await openHistory(scope, session.id);
    try {
      const page = await scanFile(handle, cursor, { roles, query, limit: limit - matches.length, maxChars: Math.min(maxChars, MAX_PAGE_CHARS - chars), snippet: true, byteBudget: SCAN_BYTES_PER_PAGE - scannedBytes, charBudget: MAX_PAGE_CHARS - chars });
      for (const message of page.messages) {
        matches.push({ ...message, sessionId: session.id, ...(session.name ? { sessionName: redactHistoryText(session.name).slice(0, 200) } : {}), ...(session.projectId ? { projectId: session.projectId } : {}) });
        chars += message.text.length;
      }
      omittedRecords += page.omittedRecords;
      scannedBytes += page.scannedBytes;
      filesScanned++;
      if (page.done) { cursor.sessionIndex++; cursor.offset = 0; delete cursor.file; delete cursor.skipRecord; }
      else { cursor.offset = page.offset; cursor.file = page.snapshot; cursor.skipRecord = page.skipRecord; }
      if (chars >= MAX_PAGE_CHARS) break;
    } finally { await handle.close(); }
  }
  return { warning: SESSION_HISTORY_WARNING, matches, omittedRecords, ...(cursor.sessionIndex < catalog.length ? { nextCursor: encodeCursor({ ...cursor, catalogHash }) } : {}) };
}
