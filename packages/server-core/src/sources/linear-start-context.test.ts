import { describe, expect, it } from 'bun:test'
import { readLinearStartIssue } from './linear-start-context'

function pool(value: unknown, name = 'get_issue') {
  const calls: unknown[] = []
  return {
    calls,
    getConnectedSlugs: () => ['linear-test'],
    getTools: () => [{name, inputSchema: {type: 'object' as const, properties: {id: {type:'string'}}, required:['id']}}],
    callTool: async (name: string, args: Record<string, unknown>) => { calls.push({name,args}); return {content: JSON.stringify(value), isError:false} },
  }
}
describe('Linear issue start through existing MCP pool', () => {
  it('reads only the requested issue through the proxy tool', async () => {
    const fixture=pool({identifier:'TEST-7',title:'Fix retry',description:'Fixture',url:'https://linear.app/team/issue/TEST-7/fix-retry'})
    expect(await readLinearStartIssue(fixture,'TEST-7')).toMatchObject({title:'Fix retry',description:'Fixture'})
    expect(fixture.calls).toEqual([{name:'mcp__linear-test__get_issue',args:{id:'TEST-7'}}])
  })
  it('does not call arbitrary or write tools', async () => {
    const fixture=pool({},'update_issue')
    await expect(readLinearStartIssue(fixture,'TEST-7')).rejects.toThrow('get_issue')
    expect(fixture.calls).toEqual([])
  })
  it('rejects other issue results and off-provider URLs', async () => {
    await expect(readLinearStartIssue(pool({identifier:'OTHER-1',title:'Wrong',url:'https://linear.app/team/issue/OTHER-1'}),'TEST-7')).rejects.toThrow('different issue')
    await expect(readLinearStartIssue(pool({title:'Wrong',url:'https://evil.example/issue/TEST-7'}),'TEST-7')).rejects.toThrow('invalid issue URL')
  })
  it('rejects invalid identifiers without a source call', async () => {
    const fixture=pool({})
    await expect(readLinearStartIssue(fixture,'https://evil.example')).rejects.toThrow('Invalid Linear')
    expect(fixture.calls).toEqual([])
  })
})
