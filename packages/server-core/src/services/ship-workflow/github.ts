import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ShipPRSnapshot } from '../../../../shared/src/protocol/ship-workflow'
const execute = promisify(execFile)
export type ShipCommandRunner = (file: string, args: string[], options: { cwd: string; timeout: number; maxBuffer: number }) => Promise<{ stdout: string; stderr?: string }>
const exec: ShipCommandRunner = async (file, args, options) => { const result = await execute(file, args, options); return { stdout: String(result.stdout), stderr: String(result.stderr) } }
export async function shipGitHead(cwd: string, run: ShipCommandRunner = exec): Promise<string> {
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd, timeout: 10_000, maxBuffer: 16_384 })
  const head = stdout.trim(); if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error('Unable to resolve repository HEAD'); return head
}
export async function assertShipEvidenceTree(cwd: string, run: ShipCommandRunner = exec): Promise<void> {
  const { stdout } = await run('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd, timeout: 10_000, maxBuffer: 256 * 1024 })
  if (stdout.trim()) throw new Error('Review/E2E proof requires a clean worktree at the exact committed HEAD. Commit owned changes and clean up disposable test files first.')
}
export async function assertShipRepository(cwd: string, run: ShipCommandRunner = exec): Promise<void> {
  const { stdout } = await run('git', ['remote', 'get-url', 'origin'], { cwd, timeout: 10_000, maxBuffer: 16_384 })
  if (/(?:[:/])sapiom\/(?:sapiom|sapiom-js)(?:\.git)?\/?$/i.test(stdout.trim())) throw new Error('Sapiom remains read-only. Native Ship workflows are disabled for this repository.')
  const { stdout: branch } = await run('git', ['branch', '--show-current'], { cwd, timeout: 10_000, maxBuffer: 16_384 })
  if (!branch.trim() || /^(main|master|dev|develop)$/.test(branch.trim())) throw new Error('Choose an isolated worktree branch before starting Ship.')
}
interface GHTree { nodes: Array<{ isResolved: boolean; comments: { nodes: Array<{ author: { login: string; __typename: string } | null }> } }>; pageInfo: { hasNextPage: boolean } }
export async function readShipPR(cwd: string, run: ShipCommandRunner = exec): Promise<ShipPRSnapshot> {
  const { stdout } = await run('gh', ['pr', 'view', '--json', 'url,number,state,isDraft,headRefOid,mergeable,reviews,comments,statusCheckRollup,commits'], { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  const pr = JSON.parse(stdout)
  const url = new URL(pr.url); const path = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/.exec(url.pathname)
  if (url.hostname !== 'github.com' || url.protocol !== 'https:' || !path) throw new Error('A canonical github.com PR is required')
  const query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{author{login __typename}}}} pageInfo{hasNextPage}} reviews(last:100){nodes{id state author{login __typename} commit{oid} body} pageInfo{hasPreviousPage}} comments(last:100){nodes{id author{login __typename} body} pageInfo{hasPreviousPage}}}}}'
  const { stdout: threadData } = await run('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${path[1]}`, '-f', `name=${path[2]}`, '-F', `number=${path[3]}`], { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  const graph = JSON.parse(threadData); if (graph.errors?.length) throw new Error('GitHub review details unavailable')
  const details = graph.data.repository.pullRequest; if (details.headRefOid !== pr.headRefOid) throw new Error('PR HEAD changed during status collection'); const tree = details.reviewThreads as GHTree
  if (details.reviews.pageInfo.hasPreviousPage || details.comments.pageInfo.hasPreviousPage) throw new Error('More than 100 review bodies/comments: manual review is required; no history was silently skipped.')
  if (tree.pageInfo.hasNextPage) throw new Error('More than 100 review threads: manual review is required; status remains blocked.')
  const isBot = (author: { login?: string; __typename?: string } | null) => author?.__typename === 'Bot' || /\[bot\]$/.test(author?.login || '') || /^(devin-ai-integration|devin-ai)$/i.test(author?.login || '')
  const reviews = details.reviews.nodes as Array<{ id: string; state: string; author: { login: string; __typename: string } | null; commit?: { oid: string }; body: string }>
  const comments = details.comments.nodes as Array<{ id: string; author: { login: string; __typename: string } | null; body: string }>
  const isDevin = (author: { login?: string } | null) => /^(?:devin-ai-integration|devin-ai)(?:\[bot\])?$/i.test(author?.login || '')
  const botCheck = (pr.statusCheckRollup || []).find((check: { name?: string }) => /devin/i.test(check.name || ''))
  const headReview = reviews.some(review => isDevin(review.author) && review.commit?.oid === pr.headRefOid)
  const headCheck = !!botCheck && botCheck.status === 'COMPLETED'
  const notConfigured = !botCheck && !reviews.some(review => isDevin(review.author))
  const committedAt = Date.parse(pr.commits?.at(-1)?.committedDate || '')
  const grace = !headReview && !headCheck && !notConfigured && Number.isFinite(committedAt) && Date.now() - committedAt >= 45 * 60_000
  const botReviewEvidence = headReview ? 'head-review' : headCheck ? 'head-check' : notConfigured ? 'not-configured' : grace ? 'grace-expired' : 'waiting'
  const latestHumanReviews = new Map<string, typeof reviews[number]>()
  for (const review of reviews) if (review.author && !isBot(review.author) && review.commit?.oid === pr.headRefOid) latestHumanReviews.set(review.author.login, review)
  const humanReviewStates = [...latestHumanReviews.values()]
  const open = tree.nodes.filter(thread => !thread.isResolved)
  let checksText: string
  try { checksText = (await run('gh', ['pr', 'checks', String(pr.number), '--required', '--json', 'name,state'], { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout }
  catch (error) { checksText = typeof (error as { stdout?: unknown }).stdout === 'string' ? (error as { stdout: string }).stdout : ''; if (!checksText.trim()) throw new Error('Required CI checks unavailable') }
  const checks = JSON.parse(checksText) as Array<{ state: string }>
  const requiredCI = !Array.isArray(checks) ? 'unknown' : checks.some(check => ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'ERROR', 'STARTUP_FAILURE'].includes(check.state)) ? 'red' : checks.some(check => !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.state)) ? 'pending' : 'green'
  return { url: pr.url, number: pr.number, head: pr.headRefOid, state: pr.state, draft: pr.isDraft, requiredCI, conflicting: pr.mergeable !== 'MERGEABLE', botOpenThreads: open.filter(thread => isBot(thread.comments.nodes[0]?.author || null)).length, humanOpenThreads: open.filter(thread => !isBot(thread.comments.nodes[0]?.author || null)).length, humanCommentIds: [...comments.filter(comment => !isBot(comment.author) && comment.body.trim()).map(comment => comment.id), ...reviews.filter(review => !isBot(review.author) && review.body.trim()).map(review => review.id)], botReviewEvidence, botReviewedHead: headReview || headCheck || notConfigured || grace, humanApprovedHead: humanReviewStates.some(review => review.state === 'APPROVED') && !humanReviewStates.some(review => review.state === 'CHANGES_REQUESTED'), checkedAt: new Date().toISOString() }
}
export async function readyShipPR(cwd: string, number: number, expectedHead: string, run: ShipCommandRunner = exec): Promise<void> {
  const current = await readShipPR(cwd, run)
  if (current.number !== number || current.head !== expectedHead || await shipGitHead(cwd, run) !== expectedHead || current.state !== 'OPEN') throw new Error('GitHub HEAD changed before ready; run review/E2E again.')
  await assertShipEvidenceTree(cwd, run)
  if (current.draft) await run('gh', ['pr', 'ready', String(number)], { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 })
}
