import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readSessionHeader, readSessionHeaderAsync } from '../jsonl.ts';
import { listSessions } from '../storage.ts';
import type { SessionHeader } from '../types.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const base: SessionHeader = { id: '261030-large-pilot', name: 'Pilote', workspaceRootPath: '/workspace',
  projectId: 'project', createdAt: 1, lastUsedAt: 2, messageCount: 1, permissionMode: 'allow-all',
  tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } };
function headerOfSize(bytes: number) {
  const empty = { ...base, transferredSessionSummary: '' };
  const header = { ...empty, transferredSessionSummary: 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(empty))) };
  expect(Buffer.byteLength(JSON.stringify(header))).toBe(bytes);
  return header;
}
function file(content: string) {
  const root = mkdtempSync(join(tmpdir(), 'craft-large-header-')); directories.push(root);
  const path = join(root, 'sessions', base.id, 'session.jsonl'); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return { root, path };
}

for (const [name, reader] of [['sync', readSessionHeader], ['async', readSessionHeaderAsync]] as const) {
  describe(`${name} complete session header`, () => {
    for (const bytes of [8191, 8192, 8248, 65536]) {
      it(`retains all ${bytes} header bytes without parsing message history`, async () => {
        const header = headerOfSize(bytes);
        const t = file(JSON.stringify(header) + '\n' + 'invalid history data\n'.repeat(50_000));
        const before = readFileSync(t.path);
        expect(await reader(t.path)).toEqual(header);
        expect(readFileSync(t.path)).toEqual(before);
      });
    }
    it('preserves multibyte UTF-8 split across the read boundary', async () => {
      const prefix = '{"transferredSessionSummary":"';
      const header = { transferredSessionSummary: 'x'.repeat(8191 - Buffer.byteLength(prefix)) + '🙂 é 日本語', ...base };
      const t = file(JSON.stringify(header) + '\n');
      expect(Buffer.from(JSON.stringify(header))[8191]).toBe(0xf0);
      expect(await reader(t.path)).toEqual(header);
    });
    it('reads an EOF-terminated header with no newline and handles CRLF', async () => {
      const header = headerOfSize(24_000);
      expect(await reader(file(JSON.stringify(header)).path)).toEqual(header);
      expect(await reader(file(JSON.stringify(header) + '\r\n').path)).toEqual(header);
    });
    it('keeps malformed, empty and missing files non-destructive', async () => {
      for (const content of ['', '{incomplete\n', '{broken']) {
        const t = file(content);
        expect(await reader(t.path)).toBeNull();
        expect(readFileSync(t.path, 'utf8')).toBe(content);
      }
      expect(await reader(join(tmpdir(), 'nonexistent-craft-header', 'session.jsonl'))).toBeNull();
    });
  });
}

it('includes a pilot with an 8249-byte first line in the real workspace session listing', () => {
  const header = headerOfSize(8248);
  const t = file(JSON.stringify(header) + '\n' + JSON.stringify({ id: 'message', role: 'user', content: 'hello' }) + '\n');
  expect(listSessions(t.root)).toEqual([expect.objectContaining({ id: base.id, projectId: base.projectId, name: 'Pilote' })]);
});
