import { McpClientPool } from '@craft-agent/shared/mcp'
import { isSourceUsable, type LoadedSource, type TokenRefreshManager } from '@craft-agent/shared/sources'
import { buildServersFromSources } from './build-servers'

export interface LinearStartIssue {
  title: string
  description?: string
  url: string
  branchName?: string
}
type IssuePool = Pick<McpClientPool, 'getConnectedSlugs' | 'getTools' | 'callTool'>

/** Only the explicitly selected issue is read, through the existing authenticated source pool. */
export async function readLinearStartIssue(pool: IssuePool, identifier: string): Promise<LinearStartIssue> {
  if (!/^[A-Za-z][A-Za-z0-9]{0,30}-\d{1,15}$/.test(identifier)) throw new Error('Invalid Linear issue identifier')
  for (const slug of pool.getConnectedSlugs()) {
    const tool = pool.getTools(slug).find(tool => /^(get_issue|getIssue)$/.test(tool.name))
    if (!tool) continue
    const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] }
    const field = ['id', 'issueId', 'identifier', 'issue_id'].find(key => key in (schema.properties ?? {}))
    if (!field || schema.required?.some(key => key !== field)) continue
    const proxyName = `mcp__${slug}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_')
    const result = await pool.callTool(proxyName, { [field]: identifier })
    if (result.isError) throw new Error('The connected Linear source could not read this issue. Check its authorization.')
    let value: any
    try { value = JSON.parse(result.content) } catch { throw new Error('Linear returned an unreadable issue response') }
    const issue = value.issue ?? value.data?.issue ?? value
    if (issue.identifier && String(issue.identifier).toLowerCase() !== identifier.toLowerCase()) throw new Error('Linear returned a different issue')
    let url: URL
    try { url = new URL(issue.url) } catch { throw new Error('Linear returned an invalid issue URL') }
    if (url.protocol !== 'https:' || url.hostname !== 'linear.app' || !url.pathname.includes(`/issue/${identifier.toUpperCase()}`)) throw new Error('Linear returned an invalid issue URL')
    if (typeof issue.title !== 'string' || !issue.title.trim()) throw new Error('Linear returned an issue without a title')
    return {
      title: issue.title.trim().slice(0, 512), url: url.href,
      ...(typeof issue.description === 'string' ? { description: issue.description.slice(0, 64_000) } : {}),
      ...(typeof issue.branchName === 'string' ? { branchName: issue.branchName } : {}),
    }
  }
  throw new Error('Connect a Linear MCP source with the get_issue tool to start from a Linear issue')
}

export async function resolveLinearStartIssue(
  sources: LoadedSource[], identifier: string, sessionPath: string,
  workspaceRootPath: string, tokenRefreshManager?: TokenRefreshManager,
): Promise<LinearStartIssue> {
  const linear = sources.filter(source => isSourceUsable(source)
    && /(^|[^a-z])linear([^a-z]|$)/i.test(`${source.config.provider} ${source.config.slug} ${source.config.name}`))
  if (!linear.length) throw new Error('Connect and authenticate a Linear source before selecting a Linear issue')
  const { mcpServers, apiServers } = await buildServersFromSources(linear, sessionPath, tokenRefreshManager)
  const pool = new McpClientPool({ workspaceRootPath, sessionPath })
  try {
    await pool.sync(mcpServers, apiServers)
    return await readLinearStartIssue(pool, identifier)
  } finally { await pool.disconnectAll() }
}
