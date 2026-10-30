import { describe, expect, it } from 'bun:test'
import { combineWebhookChanges, githubWebhookChange, parseGithubWebhookConfig, webhookCoversRepo } from './events'

const repo = { full_name: 'Acme/App' }
const sha = 'a'.repeat(40)
const change = (event: string, rest: object) => githubWebhookChange(event, { repository: repo, ...rest })

describe('GitHub repository and organization webhook coordinates', () => {
  it('is disabled by default and rejects partial/weak/invalid configuration', () => {
    expect(parseGithubWebhookConfig({})).toBeNull()
    for (const env of [{ CRAFT_GITHUB_WEBHOOK_SECRET: 'short' },
      { CRAFT_GITHUB_WEBHOOK_REPOSITORIES: 'acme/*' },
      { CRAFT_GITHUB_WEBHOOK_SECRET: sha, CRAFT_GITHUB_WEBHOOK_REPOSITORIES: '*' },
      { CRAFT_GITHUB_WEBHOOK_SECRET: sha, CRAFT_GITHUB_WEBHOOK_REPOSITORIES: 'acme/app,' }]) {
      expect(() => parseGithubWebhookConfig(env)).toThrow()
    }
    expect(parseGithubWebhookConfig({ CRAFT_GITHUB_WEBHOOK_SECRET: sha,
      CRAFT_GITHUB_WEBHOOK_REPOSITORIES: 'Acme/*, me/repo,acme/*' })?.repositories).toEqual(['acme/*', 'me/repo'])
  })

  it('authorizes exact repositories or an owner wildcard, always on GitHub.com', () => {
    const coords = { host: 'github.com', owner: 'Acme', repo: 'App' }
    expect(webhookCoversRepo(coords, ['acme/app'])).toBe(true)
    expect(webhookCoversRepo(coords, ['acme/*'])).toBe(true)
    expect(webhookCoversRepo(coords, ['other/*'])).toBe(false)
    expect(webhookCoversRepo({ ...coords, host: 'evil.test' }, ['acme/*'])).toBe(false)
  })

  it('targets PRs, reviews and threads without retaining comment text or URLs', () => {
    for (const event of ['pull_request', 'pull_request_review', 'pull_request_review_comment', 'pull_request_review_thread']) {
      const result = change(event, { pull_request: { number: 42, head: { sha, ref: 'me/feature' } }, comment: { body: 'DO NOT STORE THIS' } })!
      expect(result).toMatchObject({ repo: { host: 'github.com', owner: 'acme', repo: 'app' }, numbers: [42], shas: [sha], headRefs: ['me/feature'], all: false })
      expect(JSON.stringify(result)).not.toContain('DO NOT STORE THIS')
    }
  })

  it('refreshes dependent base branches on merge and push, but ignores tag pushes', () => {
    expect(change('pull_request', { action: 'closed', pull_request: { number: 42, merged: true, base: { ref: 'main' } } })?.baseRefs).toEqual(['main'])
    expect(change('push', { ref: 'refs/heads/main', after: sha })).toMatchObject({ headRefs: ['main'], baseRefs: ['main'], shas: [sha] })
    expect(change('push', { ref: 'refs/tags/v1', after: sha })).toBeNull()
  })

  it('accepts CI SHA-only events and PR-number associations, and repo-wide merge queue invalidation', () => {
    for (const event of ['check_run', 'check_suite']) {
      expect(change(event, { [event]: { head_sha: sha, pull_requests: [] } })?.shas).toEqual([sha])
      expect(change(event, { [event]: { head_sha: sha, pull_requests: [{ number: 42 }] } })?.numbers).toEqual([42])
    }
    expect(change('status', { sha })?.shas).toEqual([sha])
    expect(change('merge_group', {})?.all).toBe(true)
  })

  it('ignores issues and unsupported events and rejects unusable recognized payloads', () => {
    expect(change('issue_comment', { issue: { number: 42 } })).toBeNull()
    expect(change('issue_comment', { issue: { number: 42, pull_request: {} } })?.numbers).toEqual([42])
    expect(githubWebhookChange('star', null)).toBeNull()
    expect(() => githubWebhookChange('pull_request', { repository: { full_name: 'evil/../../repo' } })).toThrow()
    expect(() => change('check_run', { check_run: {} })).toThrow()
  })

  it('coalesces repeated coordinates while preserving all pending changes', () => {
    const first = change('pull_request', { pull_request: { number: 42 } })!
    const second = change('pull_request', { pull_request: { number: 43 } })!
    expect(combineWebhookChanges([first, first, second])).toMatchObject({ numbers: [42, 43], all: false })
  })
})
