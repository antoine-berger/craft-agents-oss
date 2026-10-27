import { z } from 'zod'
import type { SessionToolContext } from '../context'
import type { ToolResult } from '../types'
import { errorResponse, successResponse } from '../response'

export const RequestUserInputSchema = z.object({
  question: z.string().trim().min(1).max(4000).describe('The exact blocking question to show the user'),
  choices: z.array(z.string().trim().min(1).max(500)).max(8).optional().describe('Optional concise choices'),
})
export const MarkAttentionSchema = z.object({
  kind: z.enum(['question', 'plan', 'error']),
  title: z.string().trim().min(1).max(300),
  detail: z.string().max(4000).optional(),
})
export interface AgentAttentionRequest { kind: 'question' | 'plan' | 'error'; title: string; detail?: string }
export interface AttentionToolContext extends SessionToolContext {
  markAttention?: (request: AgentAttentionRequest) => void | Promise<void>
}
export async function handleRequestUserInput(ctx: AttentionToolContext, args: z.infer<typeof RequestUserInputSchema>): Promise<ToolResult> {
  const valid = RequestUserInputSchema.safeParse(args)
  if (!valid.success) return errorResponse('A blocking question and at most eight short choices are required.')
  if (!ctx.markAttention) return errorResponse('Human attention is unavailable in this context.')
  await ctx.markAttention({ kind: 'question', title: valid.data.question.slice(0, 300), detail: [valid.data.question, ...(valid.data.choices ?? []).map((c, i) => `${i + 1}. ${c}`)].join('\n') })
  return successResponse('Your blocking question is saved and visible in Needs you. End this turn and wait for the human response. Do not continue dependent work.')
}
export async function handleMarkAttention(ctx: AttentionToolContext, args: z.infer<typeof MarkAttentionSchema>): Promise<ToolResult> {
  const valid = MarkAttentionSchema.safeParse(args)
  if (!valid.success) return errorResponse('Invalid attention request.')
  if (!ctx.markAttention) return errorResponse('Human attention is unavailable in this context.')
  await ctx.markAttention(valid.data)
  return successResponse('Human attention saved. Describe the exact decision or fix needed and stop dependent work until the user responds.')
}
export const REQUEST_USER_INPUT_DESCRIPTION = 'Ask a genuinely blocking question whose answer is required before work can continue. Saves a persistent Needs you signal. After this tool, end your turn and wait. Never use for optional suggestions, rhetorical questions, or a routine offer to continue.'
export const MARK_ATTENTION_DESCRIPTION = 'Mark an explicit plan awaiting human approval, an error requiring human action, or a genuinely blocking question. Use concrete reasons. Never mark ordinary progress, completed work, or an optional follow-up. This does not change permissions or automatically send external messages.'
