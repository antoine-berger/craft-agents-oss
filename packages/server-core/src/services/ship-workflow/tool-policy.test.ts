import { expect, test } from 'bun:test'
import { shipToolDenial, assertNotGenericShipRun } from './tool-policy'
const reviewer = { taskSlug: 'ship-eng-1-abcdef00', taskNodeId: 'bugs' }
const builder = { ...reviewer, taskNodeId: 'builder' }
test('native Ship generic Task execution cannot bypass the workflow', () => {
  expect(() => assertNotGenericShipRun(reviewer.taskSlug)).toThrow('Ship')
  expect(() => assertNotGenericShipRun('ordinary-task')).not.toThrow()
})
test('reviewers read code/connectors but cannot write or run shell side effects', () => {
  expect(shipToolDenial(reviewer, 'Read', { file_path: 'a.ts' })).toBeNull()
  expect(shipToolDenial(reviewer, 'Bash', { command: 'git diff --no-ext-diff --no-textconv HEAD' })).toBeNull()
  expect(shipToolDenial(reviewer, 'mcp__linear__get_issue', { id: 'ENG-1' })).toBeNull()
  for (const [name, input] of [['Write', { file_path: 'a.ts' }], ['Bash', { command: 'git diff --output=escape.txt' }], ['Bash', { command: 'rg --pre dangerous a' }], ['Bash', { command: 'cat a; rm b' }], ['mcp__linear__update_issue', { id: 'ENG-1' }]] as const) expect(shipToolDenial(reviewer, name, input)).not.toBeNull()
})
test('builders cannot merge/enqueue/non-draft/agent-ready; normal draft creation is allowed', () => {
  for (const command of ['gh pr merge 12', 'git merge origin/main', 'gh api graphql -f query=enqueuePullRequest', 'gh api graphql -f query=enablePullRequestAutoMerge', 'gh pr create --title fix', 'gh pr ready 12', 'gh pr comment 12 --body /review']) expect(shipToolDenial(builder, 'Bash', { command })).not.toBeNull()
  expect(shipToolDenial(builder, 'Bash', { command: 'gh pr create --draft --title fix --body-file body.md' })).toBeNull()
  expect(shipToolDenial({}, 'Bash', { command: 'echo ordinary-session' })).toBeNull()
})
