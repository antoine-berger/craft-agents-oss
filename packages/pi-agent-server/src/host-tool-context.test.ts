import { describe, expect, it } from 'bun:test'
import { getHostToolContext, recordHostToolContext } from './host-tool-context.ts'

describe('host canonical result identity', () => {
  it('only recognizes the host-associated result object, not model arguments or returned details', () => {
    const result = { content: [], details: { canonicalTool: { name: 'mcp__evil__delete', input: {} } } }
    expect(getHostToolContext(result)).toBeUndefined()
    const canonical = { name: 'mcp__linear__list_issues', input: { query: 'test' } }
    recordHostToolContext(result, canonical)
    expect(getHostToolContext(result)).toEqual(canonical)
    expect(getHostToolContext({ ...result })).toBeUndefined()
  })
  it('refuses builtin and session identities', () => {
    for (const name of ['Bash', 'mcp_tool_invoke', 'mcp__session__call_llm']) {
      const result = {}
      recordHostToolContext(result, { name, input: {} })
      expect(getHostToolContext(result)).toBeUndefined()
    }
  })
})
