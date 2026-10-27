import type { ProxyToolDef } from './mcp-pool.ts'

export const MCP_SEARCH_TOOL = 'mcp_tool_search'
export const MCP_INVOKE_TOOL = 'mcp_tool_invoke'
const MAX_RESULTS = 5
const RESULT_BUDGET = 24_000
const SCHEMA_BUDGET = 16_000

export const DEFERRED_MCP_TOOL_DEFS: ProxyToolDef[] = [
  { name: MCP_SEARCH_TOOL, description: 'Discover connected MCP/API tools by task or source. This only searches the local tool catalogue and never executes a connector. Returns exact tool names, source provenance, and input schemas. For a large schema, request a specific tool_name and schema_path (JSON pointer, e.g. /properties/query). Read the source guide before invoking a tool. All connected tools remain available through discovery.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Task keywords, tool name, or * to browse.' }, source_slug: { type: 'string' }, tool_name: { type: 'string' }, schema_path: { type: 'string', description: 'Optional JSON pointer within this exact tool input schema.' }, limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS } }, required: ['query'], additionalProperties: false } },
  { name: MCP_INVOKE_TOOL, description: 'Invoke an exact connected MCP/API tool discovered with mcp_tool_search. Pass its full tool_name and input arguments. The host applies the real tool permissions, source activation, prerequisites, policy and result limits. This does not grant permission to bypass them. Session tools and local commands cannot be invoked through this tool.',
    inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['tool_name', 'arguments'], additionalProperties: false } },
]

export interface CanonicalMcpInvocation { toolName: string; input: Record<string, unknown> }
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const sourceOf = (name: string) => name.split('__')[1] ?? ''

/** Catalogue stays in the host. Never send hundreds of schemas to the model context. */
export class DeferredMcpToolCatalog {
  constructor(private getTools: () => ProxyToolDef[], private isConnected: (name: string) => boolean) {}

  resolveInvocation(input: Record<string, unknown>): CanonicalMcpInvocation {
    const name = input.tool_name
    if (typeof name !== 'string' || !name.startsWith('mcp__') || name.startsWith('mcp__session__') || !this.isConnected(name)) throw new Error('Unknown or disconnected MCP source tool. Search the catalogue again.')
    if (!isRecord(input.arguments)) throw new Error('Tool arguments must be a JSON object.')
    const args = { ...input.arguments }
    // Metadata remains UI-only, but the permission pipeline needs the real invocation intent.
    for (const key of ['_intent', '_displayName']) if (typeof input[key] === 'string' && !(key in args)) args[key] = input[key]
    return { toolName: name, input: args }
  }

  search(input: Record<string, unknown>): { content: string; isError: boolean } {
    if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 300) throw new Error('Search query must contain 1–300 characters.')
    for (const key of ['source_slug', 'tool_name', 'schema_path']) if (input[key] !== undefined && (typeof input[key] !== 'string' || (input[key] as string).length > 500)) throw new Error(`Invalid ${key}.`)
    if (input.schema_path && !input.tool_name) throw new Error('schema_path requires an exact tool_name.')
    const limit = input.limit === undefined ? MAX_RESULTS : input.limit
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) throw new Error('Search limit must be between 1 and 5.')
    const terms = input.query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    const tools = this.getTools().filter(tool => this.isConnected(tool.name) && !tool.name.startsWith('mcp__session__')
      && (!input.source_slug || sourceOf(tool.name) === input.source_slug) && (!input.tool_name || tool.name === input.tool_name))
      .map(tool => ({ tool, score: terms.reduce((score, term) => score + (term === '*' ? 1 : tool.name.toLowerCase().includes(term) ? 4 : tool.description.toLowerCase().includes(term) ? 1 : 0), 0) }))
      .filter(match => input.tool_name || match.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    const results: Array<Record<string, unknown>> = []
    let budget = RESULT_BUDGET - 1000
    for (const { tool } of tools.slice(0, limit)) {
      let schema: unknown = tool.inputSchema
      if (input.schema_path && ((input.schema_path as string).split('/').length > 33 || !(input.schema_path as string).startsWith('/'))) throw new Error('Schema path must be a JSON pointer beginning with /, with at most 32 segments.')
      if (input.schema_path) for (const part of (input.schema_path as string).split('/').slice(1)) {
        const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
        if ((!isRecord(schema) && !Array.isArray(schema)) || !Object.hasOwn(schema, key)) throw new Error('Schema path not found.')
        schema = (schema as Record<string, unknown>)[key]
      }
      const item: Record<string, unknown> = { tool_name: tool.name, source_slug: sourceOf(tool.name), description: tool.description.slice(0, 600) }
      const encoded = JSON.stringify(schema)
      if (encoded.length <= Math.min(SCHEMA_BUDGET, budget - 1000)) item.input_schema = schema
      else {
        const root = isRecord(schema) ? schema : {}
        const properties = isRecord(root.properties) ? root.properties : {}
        item.schema_truncated = true
        item.required = Array.isArray(root.required) ? root.required.slice(0, 40) : []
        const paths = Object.keys(properties).length ? Object.keys(properties).map(key => `properties/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`)
          : Array.isArray(schema) ? schema.map((_, index) => String(index)) : Object.keys(root).map(key => key.replace(/~/g, '~0').replace(/\//g, '~1'))
        item.schema_paths = paths.slice(0, 40).map(path => `${input.schema_path ?? ''}/${path}`)
        item.hint = 'Fetch a specific schema_path using this exact tool_name before building complex arguments.'
      }
      const size = JSON.stringify(item).length
      if (size > budget) break
      results.push(item)
      budget -= size
    }
    return { content: JSON.stringify({ tools: results, total_matches: tools.length, more: tools.length > results.length, hint: 'Use mcp_tool_invoke with the exact tool_name and arguments; normal source permissions and guide prerequisites apply.' }), isError: false }
  }
}

/** Bind execution to the final approved real tool and arguments, not a wrapper name. */
export class McpInvocationApprovals {
  private entries = new Map<string, CanonicalMcpInvocation & { expires: number; consumed: boolean }>()
  approve(id: string, invocation: CanonicalMcpInvocation): void {
    this.entries.set(id, { toolName: invocation.toolName, input: structuredClone(invocation.input), expires: Date.now() + 300_000, consumed: false })
  }
  revoke(id: string): void { this.entries.delete(id) }
  clear(): void { this.entries.clear() }
  peek(id: string): CanonicalMcpInvocation | undefined { return this.entries.get(id) }
  consume(id: string | undefined, invocation: CanonicalMcpInvocation): CanonicalMcpInvocation {
    const approved = id ? this.entries.get(id) : undefined
    if (!approved || approved.consumed || approved.expires < Date.now() || approved.toolName !== invocation.toolName || JSON.stringify(approved.input) !== JSON.stringify(invocation.input)) throw new Error('MCP invocation is missing a matching tool permission approval.')
    approved.consumed = true
    return { toolName: approved.toolName, input: approved.input }
  }
}
