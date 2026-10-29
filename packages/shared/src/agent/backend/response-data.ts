import type { AgentEvent, ResponseUsage } from '@craft-agent/core/types'

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Keep authoritative per-message snapshots; repeated SDK delivery replaces, rather than adds. */
export class ResponseUsageCollector {
  private messages = new Map<string, ResponseUsage>()

  clear(): void { this.messages.clear() }

  record(id: string, usage: ResponseUsage): void {
    this.messages.set(id, usage)
  }

  snapshot(): ResponseUsage | undefined {
    if (!this.messages.size) return undefined
    const result: ResponseUsage = {}
    const models = new Set<string>()
    const speeds = [...this.messages.values()].map(usage => usage.fast)
    for (const usage of this.messages.values()) {
      if (usage.model) models.add(usage.model)
      for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const) {
        const value = count(usage[field])
        if (value !== undefined) result[field] = (result[field] ?? 0) + value
      }
    }
    if (speeds.every(speed => speed !== undefined && speed === speeds[0])) result.fast = speeds[0]
    if (models.size === 1) result.model = [...models][0]
    else if (models.size > 1) result.models = [...models]
    return Object.keys(result).length ? result : undefined
  }
}

export function claudeResponseUsage(message: { model?: unknown; usage?: Record<string, unknown> }): ResponseUsage {
  if (message.model === '<synthetic>') return {}
  const usage = message.usage ?? {}
  return {
    ...(typeof message.model === 'string' && message.model ? { model: message.model } : {}),
    ...(count(usage.input_tokens) !== undefined ? { inputTokens: count(usage.input_tokens) } : {}),
    ...(count(usage.output_tokens) !== undefined ? { outputTokens: count(usage.output_tokens) } : {}),
    ...(count(usage.cache_read_input_tokens) !== undefined ? { cacheReadTokens: count(usage.cache_read_input_tokens) } : {}),
    ...(count(usage.cache_creation_input_tokens) !== undefined ? { cacheCreationTokens: count(usage.cache_creation_input_tokens) } : {}),
    ...(usage.speed === 'fast' ? { fast: true } : usage.speed === 'standard' ? { fast: false } : {}),
  }
}

/** Block IDs include the provider message and parent scope, including interleaved child streams. */
export class ClaudeReasoningBlocks {
  private turns = new Map<string, string>()
  private blocks = new Map<string, { text: string; turnId: string; parentToolUseId?: string; complete: boolean }>()

  clear(): void { this.turns.clear(); this.blocks.clear() }

  stream(message: { parent_tool_use_id?: string | null; event?: any }): AgentEvent[] {
    const event = message.event
    if (!event) return []
    const parentToolUseId = message.parent_tool_use_id || undefined
    const scope = parentToolUseId ?? 'root'
    if (event.type === 'message_start' && typeof event.message?.id === 'string') this.turns.set(scope, event.message.id)
    const turnId = this.turns.get(scope)
    if (!turnId || typeof event.index !== 'number') return []
    const blockId = this.id(turnId, event.index, scope)
    if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
      if (this.blocks.has(blockId)) return []
      const text = typeof event.content_block.thinking === 'string' ? event.content_block.thinking : ''
      this.blocks.set(blockId, { text, turnId, parentToolUseId, complete: false })
      return text ? [{ type: 'text_delta', text, turnId, parentToolUseId, contentKind: 'thinking', blockId }] : []
    }
    const block = this.blocks.get(blockId)
    if (!block || block.complete) return []
    if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta' && typeof event.delta.thinking === 'string') {
      block.text += event.delta.thinking
      return [{ type: 'text_delta', text: event.delta.thinking, turnId, parentToolUseId, contentKind: 'thinking', blockId }]
    }
    if (event.type === 'content_block_stop') {
      block.complete = true
      return block.text ? [{ type: 'text_complete', text: block.text, turnId, parentToolUseId, contentKind: 'thinking', blockId, isIntermediate: true }] : []
    }
    return []
  }

  assistant(message: { parent_tool_use_id?: string | null; message?: { id?: string; content?: any[] } }, indexOffset = 0): AgentEvent[] {
    const turnId = message.message?.id
    if (!turnId) return []
    const parentToolUseId = message.parent_tool_use_id || undefined
    return (message.message?.content ?? []).flatMap((block, index): AgentEvent[] => {
      if (block.type !== 'thinking' || typeof block.thinking !== 'string' || !block.thinking) return []
      const blockId = this.id(turnId, index + indexOffset, parentToolUseId ?? 'root')
      const previous = this.blocks.get(blockId)
      if (previous?.complete && previous.text === block.thinking) return []
      this.blocks.set(blockId, { text: block.thinking, turnId, parentToolUseId, complete: true })
      return [{ type: 'text_complete', text: block.thinking, turnId, parentToolUseId, contentKind: 'thinking', blockId, isIntermediate: true }]
    })
  }

  private id(turnId: string, index: number, scope: string): string { return `thinking:${scope}:${turnId}:${index}` }
}

export function proseBlockId(turnId: string, index: number, parentToolUseId?: string): string { return `text:${parentToolUseId ?? 'root'}:${turnId}:${index}` }
