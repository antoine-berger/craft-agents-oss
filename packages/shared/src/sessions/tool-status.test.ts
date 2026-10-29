import { expect, it } from 'bun:test';
import type { Message } from '@craft-agent/core/types';
import { settleToolStatuses } from './tool-status';
const tool = (id: string, fields: Partial<Message> = {}): Message => ({ id, role: 'tool', content: '', timestamp: 1, toolUseId: id, toolStatus: 'executing', ...fields });
it('settles missing foreground results, preserves known results and real terminal failures', () => {
  const original = [tool('missing'), tool('known', { toolResult: 'actual output' }), tool('failed', { toolStatus: 'error', isError: true, toolResult: 'actual failure' })];
  const result = settleToolStatuses(original);
  expect(result[0]!.toolStatus).toBe('completed'); expect(result[0]!.toolResult).toContain('No tool result');
  expect(result[1]!.toolResult).toBe('actual output'); expect(result[2]).toBe(original[2]);
  expect(original[0]!.toolStatus).toBe('executing');
});
it('protects live background roots and every descendant, including detached registry IDs', () => {
  const messages = [tool('bg', { isBackground: true, taskId: 'task', toolStatus: 'backgrounded' }), tool('child', { parentToolUseId: 'bg' }), tool('nested', { parentToolUseId: 'child' }), tool('ordinary')];
  expect(settleToolStatuses(messages).map(m => m.toolStatus)).toEqual(['backgrounded', 'executing', 'executing', 'completed']);
  expect(settleToolStatuses([tool('registry'), tool('child', { parentToolUseId: 'registry' })], { activeToolUseIds: new Set(['registry']) }).every(m => m.toolStatus === 'executing')).toBe(true);
});
it('limits historical repair to older records and scoped task completion to its own tree', () => {
  const messages = [tool('old'), tool('new', { timestamp: 20 }), tool('bg', { isBackground: true, taskId: 'task', toolStatus: 'backgrounded' })];
  expect(settleToolStatuses(messages, { before: 10 }).map(m => m.toolStatus)).toEqual(['completed', 'executing', 'backgrounded']);
  const scoped = settleToolStatuses([tool('root', { toolStatus: 'completed' }), tool('child', { parentToolUseId: 'root' }), tool('other')], { rootToolUseId: 'root' });
  expect(scoped.map(m => m.toolStatus)).toEqual(['completed', 'completed', 'executing']);
});
it('keeps interrupted foreground calls as errors and terminates cyclic ancestry safely', () => {
  expect(settleToolStatuses([tool('a')], { reason: 'interrupted' })[0]).toMatchObject({ toolStatus: 'error', isError: true });
  expect(settleToolStatuses([tool('a', { parentToolUseId: 'b' }), tool('b', { parentToolUseId: 'a' })]).every(m => m.toolStatus === 'completed')).toBe(true);
});
