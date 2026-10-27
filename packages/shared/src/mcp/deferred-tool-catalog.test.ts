import { describe, expect, it } from 'bun:test'
import { DeferredMcpToolCatalog, DEFERRED_MCP_TOOL_DEFS, McpInvocationApprovals } from './deferred-tool-catalog.ts'

const tools = Array.from({ length: 783 }, (_, i) => ({ name: `mcp__source${i % 8}__action_${i}`, description: `Find records for task ${i}`, inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'x'.repeat(3000) } }, required: ['query'] } }))
const names = new Set(tools.map(tool => tool.name))
const catalog = new DeferredMcpToolCatalog(() => tools, name => names.has(name))

describe('bounded deferred MCP catalogue', () => {
  it('projects two small schemas while keeping every connector tool discoverable', () => {
    expect(DEFERRED_MCP_TOOL_DEFS).toHaveLength(2)
    expect(JSON.stringify(DEFERRED_MCP_TOOL_DEFS).length).toBeLessThan(4000)
    const result = catalog.search({ query: '*', tool_name: tools[782]!.name })
    expect(JSON.parse(result.content).tools[0].tool_name).toBe(tools[782]!.name)
    expect(result.content.length).toBeLessThan(24_000)
    expect(catalog.resolveInvocation({ tool_name: tools[782]!.name, arguments: { query: 'hello' } })).toEqual({ toolName: tools[782]!.name, input: { query: 'hello' } })
  })
  it('bounds large schemas and supports exact JSON-pointer lookup without fetching anything', () => {
    const big = { name: 'mcp__one__big', description: 'Large schema', inputSchema: { type: 'object', properties: { body: { type: 'string', description: 'x'.repeat(50_000) }, query: { type: 'string' } } } }
    const local = new DeferredMcpToolCatalog(() => [big], name => name === big.name)
    const result = JSON.parse(local.search({ query: '*', tool_name: big.name }).content)
    expect(result.tools[0].schema_truncated).toBe(true)
    expect(result.tools[0].schema_paths).toContain('/properties/query')
    const selected = JSON.parse(local.search({ query: '*', tool_name: big.name, schema_path: '/properties/query' }).content)
    expect(selected.tools[0].input_schema).toEqual({ type: 'string' })
    expect(() => local.search({ query: '*', tool_name: big.name, schema_path: '/__proto__' })).toThrow('not found')
  })
  it('rejects session tools, arbitrary names, disconnected tools and malformed arguments', () => {
    for (const name of ['Bash', 'mcp_tool_invoke', 'mcp__session__call_llm', 'mcp__missing__delete']) expect(() => catalog.resolveInvocation({ tool_name: name, arguments: {} })).toThrow('Unknown or disconnected')
    expect(() => catalog.resolveInvocation({ tool_name: tools[0]!.name, arguments: [] })).toThrow('JSON object')
    expect(() => catalog.search({ query: '*' , limit: 999 })).toThrow('between 1 and 5')
    expect(() => catalog.search({ query: '*', schema_path: '/properties/query' })).toThrow('exact tool_name')
  })
})

describe('deferred invocation approval binding', () => {
  it('binds the real name and final arguments to a single tool call, rejecting changes/replay', () => {
    const approvals = new McpInvocationApprovals()
    const original = { toolName: 'mcp__one__delete', input: { id: 'record-a' } }
    expect(() => approvals.consume('call-a', original)).toThrow('permission approval')
    approvals.approve('call-a', original)
    expect(() => approvals.consume('call-b', original)).toThrow('permission approval')
    expect(() => approvals.consume('call-a', { ...original, input: { id: 'record-b' } })).toThrow('permission approval')
    expect(() => approvals.consume('call-a', { ...original, toolName: 'mcp__two__delete' })).toThrow('permission approval')
    expect(approvals.consume('call-a', original)).toEqual(original)
    expect(() => approvals.consume('call-a', original)).toThrow('permission approval')
    approvals.approve('call-c', original)
    approvals.clear()
    expect(() => approvals.consume('call-c', original)).toThrow('permission approval')
  })
})
