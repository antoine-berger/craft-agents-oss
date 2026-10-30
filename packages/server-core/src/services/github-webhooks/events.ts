import type { RepoCoordinates } from '../pr-watch/remote-url'

export const GITHUB_WEBHOOK_PATH = '/webhooks/github'

export interface GithubWebhookConfig {
  secret: string
  /** GitHub.com owner/repo or owner/*, lower-cased. */
  repositories: string[]
}

/** Only invalidation coordinates are retained; never messages, credentials or raw payloads. */
export interface GithubWebhookChange {
  repo: RepoCoordinates
  numbers: number[]
  shas: string[]
  headRefs: string[]
  baseRefs: string[]
  all: boolean
}

/** Only the targets still waiting for a successful refresh need another attempt. */
export interface GithubWebhookRetry {
  retryAfterMs: number
  change: GithubWebhookChange
}

const REPOSITORY = /^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i
const SCOPE = /^[a-z0-9][a-z0-9-]*\/(?:[a-z0-9_.-]+|\*)$/i
const EVENTS = new Set(['pull_request', 'pull_request_review', 'pull_request_review_comment',
  'pull_request_review_thread', 'issue_comment', 'check_run', 'check_suite', 'status', 'push', 'merge_group'])

export function parseGithubWebhookConfig(env: Record<string, string | undefined>): GithubWebhookConfig | null {
  const secret = env.CRAFT_GITHUB_WEBHOOK_SECRET
  const scopes = env.CRAFT_GITHUB_WEBHOOK_REPOSITORIES
  if (!secret && !scopes) return null
  if (!secret || secret.length < 32 || !scopes?.trim()) {
    throw new Error('GitHub webhooks require CRAFT_GITHUB_WEBHOOK_SECRET (32+ characters) and CRAFT_GITHUB_WEBHOOK_REPOSITORIES (owner/repo or owner/*).')
  }
  const repositories = [...new Set(scopes.split(',').map(scope => scope.trim().toLowerCase()))]
  if (repositories.some(scope => !SCOPE.test(scope))) throw new Error('Invalid CRAFT_GITHUB_WEBHOOK_REPOSITORIES: use comma-separated owner/repo or owner/*.')
  return { secret, repositories }
}

export function webhookCoversRepo(repo: RepoCoordinates, scopes: readonly string[]): boolean {
  return repo.host.toLowerCase() === 'github.com' && scopes.some(scope =>
    scope === `${repo.owner}/${repo.repo}`.toLowerCase() || scope === `${repo.owner}/*`.toLowerCase())
}

function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

/** Unknown events and issue-only comments are acknowledged without GitHub reads. */
export function githubWebhookChange(event: string, payload: unknown): GithubWebhookChange | null {
  if (!EVENTS.has(event)) return null
  const body = record(payload)
  const fullName = record(body.repository).full_name
  if (typeof fullName !== 'string' || !REPOSITORY.test(fullName)) throw new Error('Missing or invalid repository.full_name')
  const [owner, repo] = fullName.toLowerCase().split('/') as [string, string]
  const change: GithubWebhookChange = { repo: { host: 'github.com', owner, repo }, numbers: [], shas: [], headRefs: [], baseRefs: [], all: false }
  const addNumber = (value: unknown) => { if (Number.isSafeInteger(value) && (value as number) > 0) change.numbers.push(value as number) }
  const addRef = (values: string[], value: unknown) => { if (typeof value === 'string' && value.length > 0 && value.length <= 1024) values.push(value) }
  const addSha = (value: unknown) => { if (typeof value === 'string' && /^[a-f0-9]{40,64}$/i.test(value)) change.shas.push(value.toLowerCase()) }
  if (event.startsWith('pull_request')) {
    const pr = record(body.pull_request)
    addNumber(pr.number ?? body.number)
    addRef(change.headRefs, record(pr.head).ref)
    addSha(record(pr.head).sha)
    if (body.action === 'closed' && pr.merged === true) addRef(change.baseRefs, record(pr.base).ref)
  } else if (event === 'issue_comment') {
    const issue = record(body.issue)
    if (!issue.pull_request) return null
    addNumber(issue.number)
  } else if (event === 'check_run' || event === 'check_suite') {
    const check = record(body[event])
    addSha(check.head_sha)
    if (Array.isArray(check.pull_requests)) for (const pr of check.pull_requests) addNumber(record(pr).number)
  } else if (event === 'status') {
    addSha(body.sha)
  } else if (event === 'push') {
    if (typeof body.ref !== 'string' || !body.ref.startsWith('refs/heads/')) return null
    addRef(change.headRefs, body.ref.slice(11))
    addRef(change.baseRefs, body.ref.slice(11))
    addSha(body.after)
  } else if (event === 'merge_group') {
    change.all = true
  }
  if (!change.all && !change.numbers.length && !change.shas.length && !change.headRefs.length && !change.baseRefs.length) {
    throw new Error(`Missing ${event} invalidation coordinates`)
  }
  return change
}

export function combineWebhookChanges(changes: GithubWebhookChange[]): GithubWebhookChange {
  const first = changes[0]!
  return {
    repo: first.repo,
    numbers: [...new Set(changes.flatMap(change => change.numbers))],
    shas: [...new Set(changes.flatMap(change => change.shas))],
    headRefs: [...new Set(changes.flatMap(change => change.headRefs))],
    baseRefs: [...new Set(changes.flatMap(change => change.baseRefs))],
    all: changes.some(change => change.all),
  }
}
