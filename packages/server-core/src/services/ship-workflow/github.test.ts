import { expect, test } from 'bun:test'
import { assertShipRepository, readShipPR, readyShipPR, type ShipCommandRunner } from './github'
function fixture() {
  const head = 'a'.repeat(40), other = 'b'.repeat(40)
  const pr = { url: 'https://github.com/owner/disposable/pull/12', number: 12, headRefOid: head, isDraft: true, state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [], commits: [{ committedDate: new Date().toISOString() }] }
  const details = { headRefOid: head, reviewThreads: { nodes: [] as unknown[], pageInfo: { hasNextPage: false } }, reviews: { nodes: [] as unknown[], pageInfo: { hasPreviousPage: false } }, comments: { nodes: [] as unknown[], pageInfo: { hasPreviousPage: false } } }
  const checks = [{ name: 'Required fixture check', state: 'SUCCESS' }]
  const calls: string[][] = []; let dirty = false, remote = 'git@github.com:owner/disposable.git', branch = 'owner/eng-1-fixture'
  const run: ShipCommandRunner = async (file, args) => {
    calls.push([file, ...args])
    if (file === 'git') return { stdout: args[0] === 'status' ? dirty ? ' M file.ts\n' : '' : args[0] === 'branch' ? branch : args[0] === 'remote' ? remote : head }
    if (args[0] === 'api') return { stdout: JSON.stringify({ data: { repository: { pullRequest: details } } }) }
    if (args[1] === 'checks') return { stdout: JSON.stringify(checks) }
    if (args[1] === 'ready') return { stdout: '' }
    return { stdout: JSON.stringify(pr) }
  }
  return { head, other, pr, details, checks, calls, run, setDirty: () => { dirty = true }, setRemote: (value: string) => { remote = value }, setBranch: (value: string) => { branch = value } }
}
test('required CI and human approvals stay bound to this head; approval text is still queued for reading', async () => {
  const f = fixture()
  f.details.reviews.nodes.push({ id: 'old', state: 'APPROVED', commit: { oid: f.other }, author: { login: 'human', __typename: 'User' }, body: 'Old approval' })
  let result = await readShipPR('/fixture', f.run)
  expect(result.humanApprovedHead).toBe(false); expect(result.requiredCI).toBe('green'); expect(result.botReviewEvidence).toBe('not-configured')
  f.details.reviews.nodes.push({ id: 'new', state: 'APPROVED', commit: { oid: f.head }, author: { login: 'human', __typename: 'User' }, body: 'Approved, but please fix this condition.' })
  result = await readShipPR('/fixture', f.run)
  expect(result.humanApprovedHead).toBe(true); expect(result.humanCommentIds).toContain('new')
  f.checks[0]!.state = 'FAILURE'; expect((await readShipPR('/fixture', f.run)).requiredCI).toBe('red')
  f.checks[0]!.state = 'IN_PROGRESS'; expect((await readShipPR('/fixture', f.run)).requiredCI).toBe('pending')
})
test('partial GitHub history or a racing remote head is blocked rather than called reviewed', async () => {
  const f = fixture(); f.details.reviewThreads.pageInfo.hasNextPage = true
  await expect(readShipPR('/fixture', f.run)).rejects.toThrow('100 review threads')
  f.details.reviewThreads.pageInfo.hasNextPage = false; f.details.comments.pageInfo.hasPreviousPage = true
  await expect(readShipPR('/fixture', f.run)).rejects.toThrow('100 review bodies/comments')
  f.details.comments.pageInfo.hasPreviousPage = false; f.details.headRefOid = f.other
  await expect(readShipPR('/fixture', f.run)).rejects.toThrow('HEAD changed')
})
test('ready adapter checks current local/remote head and clean worktree, exposes no merge operation', async () => {
  const f = fixture(); await readyShipPR('/fixture', 12, f.head, f.run)
  expect(f.calls.some(call => call[0] === 'gh' && call[2] === 'ready')).toBe(true)
  expect(f.calls.some(call => call.includes('merge'))).toBe(false)
  f.setDirty(); await expect(readyShipPR('/fixture', 12, f.head, f.run)).rejects.toThrow('clean worktree')
  await expect(readyShipPR('/fixture', 12, f.other, f.run)).rejects.toThrow('HEAD changed')
})
test('the current Sapiom read-only rule and isolated-branch requirement are enforced before dispatch', async () => {
  const f = fixture(); f.setRemote('git@github.com:sapiom/Sapiom.git')
  await expect(assertShipRepository('/fixture', f.run)).rejects.toThrow('read-only')
  f.setRemote('https://github.com/sapiom/sapiom-js.git'); await expect(assertShipRepository('/fixture', f.run)).rejects.toThrow('read-only')
  f.setRemote('git@github.com:owner/disposable.git'); f.setBranch('main'); await expect(assertShipRepository('/fixture', f.run)).rejects.toThrow('isolated')
})
