import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CliProxyImportAccount } from '@craft-agent/shared/protocol'

function jwtClaims(token: string | undefined): Record<string, any> {
  try { return JSON.parse(Buffer.from(token!.split('.')[1]!, 'base64url').toString('utf8')) }
  catch { return {} }
}

/** Called only by explicit desktop import; originals and Keychain entries are never modified. */
export async function readLocalProxyAccounts(): Promise<CliProxyImportAccount[]> {
  const accounts: CliProxyImportAccount[] = []
  for (const profile of ['.claude', '.claude-alt', '.claude-third']) {
    const root = join(homedir(), profile)
    try {
      let payload: string
      if (process.platform === 'darwin') {
        const service = `Claude Code-credentials${profile === '.claude' ? '' : `-${createHash('sha256').update(root.normalize('NFC')).digest('hex').slice(0, 8)}`}`
        payload = (await promisify(execFile)('/usr/bin/security', ['find-generic-password', '-s', service, '-a', userInfo().username, '-w'], { timeout: 5000 })).stdout
      } else { payload = await readFile(join(root, '.credentials.json'), 'utf8') }
      const oauth = JSON.parse(payload).claudeAiOauth
      if (!oauth?.accessToken || !oauth.refreshToken) continue
      let identity: Record<string, any> = {}
      try { identity = JSON.parse(await readFile(profile === '.claude' ? join(homedir(), '.claude.json') : join(root, '.claude.json'), 'utf8')).oauthAccount ?? {} } catch { /* Optional CLI metadata. */ }
      accounts.push({ provider: 'claude', label: profile === '.claude' ? 'Claude CLI' : `Claude ${profile.slice(1)}`,
        accessToken: oauth.accessToken, refreshToken: oauth.refreshToken, expiresAt: oauth.expiresAt,
        email: identity.emailAddress ?? identity.email, accountId: identity.accountUuid })
    } catch { /* A missing/locked profile is skipped; the user can connect it with OAuth instead. */ }
  }
  try {
    const stored = JSON.parse(await readFile(join(homedir(), '.codex', 'auth.json'), 'utf8'))
    const tokens = stored.tokens
    if (tokens?.access_token && tokens?.refresh_token) {
      const identity = jwtClaims(tokens.id_token)
      const claims = jwtClaims(tokens.access_token)
      accounts.push({ provider: 'codex', label: 'ChatGPT / Codex', accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token, idToken: tokens.id_token, email: identity.email,
        accountId: tokens.account_id ?? identity['https://api.openai.com/auth']?.chatgpt_account_id,
        expiresAt: typeof claims.exp === 'number' ? claims.exp * 1000 : undefined })
    }
  } catch { /* No local Codex account. */ }
  return accounts
}
