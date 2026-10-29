import { describe, it, expect } from 'bun:test';
import { handleSendAgentMessage } from './send-agent-message.ts';
import type { SessionToolContext, SendAgentMessageResult } from '../context.ts';

function createCtx(
  result: SendAgentMessageResult,
  opts?: { name?: string },
): { ctx: SessionToolContext; calls: Array<{ sessionId: string; message: string }> } {
  const calls: Array<{ sessionId: string; message: string }> = [];
  const ctx = {
    sessionId: 'sender-1',
    getSessionInfo: () => (opts?.name ? ({ name: opts.name } as never) : null),
    sendAgentMessage: async (sessionId: string, message: string) => {
      calls.push({ sessionId, message });
      return result;
    },
  } as unknown as SessionToolContext;
  return { ctx, calls };
}

describe('handleSendAgentMessage delivery ack', () => {
  it('reports a delivered ack when the target was idle', async () => {
    const { ctx } = createCtx({ delivery: 'delivered', targetBusy: false });
    const res = await handleSendAgentMessage(ctx, { sessionId: 'target-9', message: 'hi' });
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res)).toContain('delivered');
  });

  it('reports a queued (busy) ack when the target was mid-turn', async () => {
    const { ctx } = createCtx({ delivery: 'queued', targetBusy: true });
    const res = await handleSendAgentMessage(ctx, { sessionId: 'target-9', message: 'status?' });
    expect(res.isError).toBeFalsy();
    const text = JSON.stringify(res);
    expect(text).toContain('queued');
    // Must warn the sender not to assume the message was read yet.
    expect(text.toLowerCase()).toContain('do not assume it was read');
  });

  it('wraps the message with a sender envelope', async () => {
    const { ctx, calls } = createCtx({ delivery: 'delivered', targetBusy: false }, { name: 'Monitor' });
    await handleSendAgentMessage(ctx, { sessionId: 'target-9', message: 'ping' });
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toContain('sender-1');
    expect(calls[0].message).toContain('ping');
  });

  it('rejects a self-send', async () => {
    const { ctx } = createCtx({ delivery: 'delivered', targetBusy: false });
    const res = await handleSendAgentMessage(ctx, { sessionId: 'sender-1', message: 'loop' });
    expect(res.isError).toBe(true);
  });
});

describe('grouped agent messages', () => {
  it('dispatches independent recipients together, preserving prompts, attachments and partial results', async () => {
    const calls: Array<{ id: string; text: string; files: unknown }> = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const ctx = {
      sessionId: 'pilot',
      sendAgentMessage: async (id: string, text: string, files: unknown) => {
        calls.push({ id, text, files })
        if (id === 'slow') await gate
        if (id === 'archived') throw Error('chat is archived')
        return { delivery: 'delivered', targetBusy: false, messageId: id }
      },
    } as any
    const attachments = [{ path: '/tmp/plan.md' }]
    const result = handleSendAgentMessage(ctx, { messages: [
      { sessionId: 'slow', message: '/ship', attachments },
      { sessionId: 'other', message: '/ship' },
      { sessionId: 'archived', message: '/ship' },
      { sessionId: 'pilot', message: 'self-send forbidden' },
    ] })
    expect(calls.map(call => call.id)).toEqual(['slow', 'other', 'archived'])
    expect(calls[0]!.text.endsWith('\n/ship')).toBe(true)
    expect(calls[0]!.files).toEqual(attachments)
    release()
    const response = await result
    const payload = JSON.parse((response.content[0] as any).text)
    expect(payload.results.map((item: any) => item.delivery)).toEqual(['delivered', 'delivered', 'error', 'error'])
  })
  it('rejects mixed single/batch arguments without sending any entry', async () => {
    let calls = 0
    const result = await handleSendAgentMessage({ sessionId: 'pilot', sendAgentMessage: async () => { calls++; return { delivery: 'delivered', targetBusy: false } } } as any,
      { sessionId: 'single', messages: [{ sessionId: 'batch', message: 'hello' }] })
    expect(result.isError).toBe(true); expect(calls).toBe(0)
  })
})
