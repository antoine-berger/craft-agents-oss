import type { SessionToolContext, SendAgentMessageResult } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

interface AgentMessage {
  sessionId: string;
  message: string;
  attachments?: Array<{ path: string; name?: string }>;
}
export interface SendAgentMessageArgs extends Partial<AgentMessage> {
  messages?: AgentMessage[];
}

export async function handleSendAgentMessage(ctx: SessionToolContext, args: SendAgentMessageArgs): Promise<ToolResult> {
  if (!ctx.sendAgentMessage) return errorResponse('send_agent_message is not available in this context.');

  const send = async (entry: Partial<AgentMessage>): Promise<SendAgentMessageResult> => {
    if (!entry.sessionId?.trim()) throw new Error('sessionId is required.');
    if (!entry.message?.trim()) throw new Error('message is required.');
    if (entry.sessionId === ctx.sessionId) throw new Error('Cannot send a message to your own session. Use a different sessionId.');
    const senderName = ctx.getSessionInfo?.()?.name ?? ctx.sessionId;
    const wrappedMessage = [
      `[Message from session "${ctx.sessionId}" (${senderName})]`,
      `Use send_agent_message with sessionId "${ctx.sessionId}" to reply.`,
      '', '---', '', entry.message,
    ].join('\n');
    return ctx.sendAgentMessage!(entry.sessionId, wrappedMessage, entry.attachments);
  };

  if (args.messages !== undefined) {
    if (!Array.isArray(args.messages) || args.messages.length === 0 || args.messages.length > 100) {
      return errorResponse('messages must contain between 1 and 100 entries.');
    }
    if (args.sessionId !== undefined || args.message !== undefined || args.attachments !== undefined) {
      return errorResponse('Use messages alone for a batch; put options on each item.');
    }
    const results = await Promise.all(args.messages.map(async (entry, index) => {
      try {
        const result = await send(entry);
        return { index, sessionId: entry.sessionId, ...result };
      } catch (error) {
        return { index, sessionId: entry?.sessionId, delivery: 'error' as const, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    return successResponse(JSON.stringify({ results }));
  }

  try {
    const result = await send(args);
    if (result.delivery === 'queued') {
      return successResponse(
        `Message queued for session ${args.sessionId} — it is currently processing another turn or has pending messages. ` +
        'Do not assume it was read yet; wait for a reply or query status before concluding anything.',
      );
    }
    return successResponse(`Message delivered to session ${args.sessionId}; it will start processing independently now.`);
  } catch (error) {
    return errorResponse(`Failed to send message: ${error instanceof Error ? error.message : String(error)}`);
  }
}
