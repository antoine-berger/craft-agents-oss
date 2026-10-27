import {
  isLocalConnection,
  type LlmConnection,
} from '@config/llm-connections'

/**
 * Format token count for display (e.g., 1500 -> "1.5k", 200000 -> "200k").
 * Shared by the desktop model dropdown and the compact (drawer) model picker.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k`
  }
  return tokens.toString()
}

/**
 * Strip the "pi/" prefix from model IDs/display names so the user sees a
 * provider-agnostic label in the picker (e.g., "pi/claude-opus" → "claude-opus").
 */
export function stripPiPrefixForDisplay(value: string): string {
  return value.startsWith('pi/') ? value.slice(3) : value
}

export type ConnectionGroup = [groupName: string, connections: LlmConnection[]]

/**
 * Group connections by provider type for hierarchical picker rendering.
 * Each provider section can contain multiple connections (API Key, OAuth, …).
 * Order is significant for UI: Anthropic, OpenAI, Local, Craft Agents Backend.
 * Empty groups are dropped.
 */
export function groupConnectionsByProvider<T extends LlmConnection>(
  connections: readonly T[],
): Array<[string, T[]]> {
  const groups: Record<string, T[]> = {
    'Anthropic': [],
    'OpenAI': [],
    'Local': [],
    'Craft Agents Backend': [],
  }
  for (const conn of connections) {
    const provider = conn.providerType || 'anthropic'
    if (provider === 'anthropic' || conn.piAuthProvider === 'anthropic') {
      groups['Anthropic'].push(conn)
    } else if (conn.piAuthProvider === 'openai' || conn.piAuthProvider === 'openai-codex' || /^https?:\/\/api\.openai\.com(?:\/|$)/i.test(conn.baseUrl ?? '')) {
      groups['OpenAI'].push(conn)
    } else if (provider === 'pi_compat' && isLocalConnection(conn)) {
      groups['Local'].push(conn)
    } else if (provider === 'pi' || provider === 'pi_compat') {
      groups['Craft Agents Backend'].push(conn)
    }
  }
  return Object.entries(groups).filter(([, conns]) => conns.length > 0)
}

export type PickerModel = string | { id: string; name?: string }

/** Render exact IDs, without registry aliases that can rename an older version to a newer one. */
export function getPickerModelName(model: PickerModel): string {
  const id = typeof model === 'string' ? model : model.id
  const bare = stripPiPrefixForDisplay(id).split('/').pop()!
    .replace(/^(?:[a-z]{2}\.)?anthropic\./, '').replace(/-v\d+:\d+$/, '').replace(/-\d{8}$/, '')
  const claude = bare.match(/^claude-(opus|sonnet|haiku|fable)-(\d+(?:[-.]\d+)*)$/)
  const legacyClaude = bare.match(/^claude-(\d+(?:[-.]\d+)*)-(opus|sonnet|haiku|fable)$/)
  if (claude || legacyClaude) {
    const family = claude?.[1] ?? legacyClaude![2]
    const version = (claude?.[2] ?? legacyClaude![1]).replace(/-/g, '.')
    return `${family[0].toUpperCase()}${family.slice(1)} ${version}`
  }
  const gpt = bare.match(/^gpt-(\d+(?:[-.]\d+)*(?:o)?)(?:-(.+))?$/)
  if (gpt) {
    const suffix = gpt[2]?.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join(' ')
    return `GPT ${gpt[1].replace(/-/g, '.')}${suffix ? ` ${suffix}` : ''}`
  }
  return typeof model === 'string' ? stripPiPrefixForDisplay(model) : model.name ?? stripPiPrefixForDisplay(id)
}

export function getPickerModelFamily(model: PickerModel): string {
  return getPickerModelName(model).split(' ')[0]
}

/** Keep families together and versions descending; preserve the original option IDs and metadata. */
export function sortPickerModels<T extends PickerModel>(models: readonly T[]): T[] {
  const families = ['Opus', 'Sonnet', 'Haiku', 'Fable', 'GPT']
  const rank = (model: T) => {
    const index = families.indexOf(getPickerModelFamily(model))
    return index < 0 ? families.length : index
  }
  return [...models].sort((a, b) => {
    const family = rank(a) - rank(b) || getPickerModelFamily(a).localeCompare(getPickerModelFamily(b))
    if (family) return family
    const nameA = getPickerModelName(a), nameB = getPickerModelName(b)
    const versionA = nameA.match(/\d+(?:\.\d+)*/)?.[0] ?? ''
    const versionB = nameB.match(/\d+(?:\.\d+)*/)?.[0] ?? ''
    return versionB.localeCompare(versionA, undefined, { numeric: true }) || nameA.localeCompare(nameB, undefined, { numeric: true })
  })
}

/** Keep a shared proxy catalogue inside its actual account-pool provider. */
export function connectionPickerModels<T extends PickerModel>(slug: string, models: readonly T[]): T[] {
  const id = (model: T) => stripPiPrefixForDisplay(typeof model === 'string' ? model : model.id)
  if (slug === 'cli-proxy-claude') return models.filter(model => id(model).startsWith('claude-'))
  if (slug === 'cli-proxy-codex') return models.filter(model => /^(gpt-|o[134](?:-|$))/.test(id(model)) && !id(model).startsWith('gpt-image-'))
  return [...models]
}
