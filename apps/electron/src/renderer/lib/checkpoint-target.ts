import type { Message } from '../../shared/types'

/** Use stored message order, including hidden prompts, to keep the selected reply. */
export function getNextUserMessageId(messages: readonly Pick<Message, 'id' | 'role' | 'hidden'>[], replyId: string): string | undefined {
  const index = messages.findIndex(message => message.id === replyId)
  return index < 0 ? undefined : messages.slice(index + 1).find(message => message.role === 'user')?.id
}
