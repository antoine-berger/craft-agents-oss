import { beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import type { SessionHeader } from '../types.ts';

// Run separately: these filesystem spies must not affect other session tests.
const realFs = { ...fs };
const realFsPromises = { ...fsPromises };
const FILE = '/isolated-header/session.jsonl';
const FD = 987654;
const headerBase: SessionHeader = { id: 'pilot', workspaceRootPath: '/workspace', createdAt: 1,
  lastUsedAt: 2, messageCount: 1, permissionMode: 'allow-all',
  tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } };
let contents = Buffer.alloc(0);
let chunkLimit = Infinity;
let failReadAt = Infinity;
let failures = 0;
let closed = 0;
let reads: Array<{ position: number; bytes: number }> = [];

function read(buffer: Buffer, offset: number, length: number, position: number): number {
  if (reads.length === failReadAt) { failures++; throw new Error('simulated read failure'); }
  const bytes = Math.min(length, chunkLimit, Math.max(0, contents.length - position));
  contents.copy(buffer, offset, position, position + bytes);
  reads.push({ position, bytes });
  return bytes;
}

mock.module('fs', () => ({
  ...realFs,
  openSync: (...args: Parameters<typeof fs.openSync>) => args[0] === FILE ? FD : realFs.openSync(...args),
  readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
    fd === FD ? read(buffer, offset, length, position) : realFs.readSync(fd, buffer, offset, length, position),
  closeSync: (fd: number) => { if (fd === FD) closed++; else realFs.closeSync(fd); },
}));
mock.module('fs/promises', () => ({
  ...realFsPromises,
  open: async (...args: Parameters<typeof fsPromises.open>) => args[0] === FILE ? {
    read: async (buffer: Buffer, offset: number, length: number, position: number) => ({ bytesRead: read(buffer, offset, length, position), buffer }),
    close: async () => { closed++; },
  } : realFsPromises.open(...args),
}));

const { readSessionHeader, readSessionHeaderAsync } = await import('../jsonl.ts');
beforeEach(() => { contents = Buffer.alloc(0); chunkLimit = Infinity; failReadAt = Infinity; failures = 0; closed = 0; reads = []; });

for (const [name, reader] of [['sync', readSessionHeader], ['async', readSessionHeaderAsync]] as const) {
  describe(`${name} first-line I/O boundaries`, () => {
    it('stops reading after the block containing LF, regardless of history size', async () => {
      const header = { ...headerBase, transferredSessionSummary: 'x'.repeat(9000) };
      contents = Buffer.from(JSON.stringify(header) + '\n' + 'unread history\n'.repeat(100_000));
      expect(await reader(FILE)).toEqual(header);
      expect(reads.map(call => call.position)).toEqual([0, 8192]);
      expect(reads.reduce((total, call) => total + call.bytes, 0)).toBe(16384);
      expect(closed).toBe(1);
    });

    it('continues through short reads until the complete header is available', async () => {
      const header = { ...headerBase, transferredSessionSummary: 'x'.repeat(300) };
      contents = Buffer.from(JSON.stringify(header) + '\n' + 'history'.repeat(100));
      chunkLimit = 17;
      expect(await reader(FILE)).toEqual(header);
      expect(reads.length).toBeGreaterThan(10);
      for (let i = 0; i < reads.length; i++) expect(reads[i]!.position).toBe(i * 17);
      expect(closed).toBe(1);
    });

    it('closes the descriptor after an error during a later read', async () => {
      contents = Buffer.from(JSON.stringify({ id: 'pilot', transferredSessionSummary: 'x'.repeat(9000) }) + '\n');
      failReadAt = 1;
      expect(await reader(FILE)).toBeNull();
      expect(failures).toBe(1);
      expect(reads).toHaveLength(1);
      expect(closed).toBe(1);
    });

    it('closes the descriptor when parsing the first line fails', async () => {
      contents = Buffer.from('{broken\nhistory');
      expect(await reader(FILE)).toBeNull();
      expect(reads).toHaveLength(1);
      expect(closed).toBe(1);
    });
  });
}
