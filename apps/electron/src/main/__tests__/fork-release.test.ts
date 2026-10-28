import { describe, expect, test } from 'bun:test'
import { FORK_REPOSITORY, FORK_RELEASE_URL, isNewerVersion, parseForkRelease } from '../fork-release'

const release = () => ({ schema: 1, repository: FORK_REPOSITORY, version: '0.15.7', assets: Object.fromEntries([
  ['darwin-arm64', 'Craft-Agents-arm64.zip'], ['server-linux-x64', 'craft-server-linux-x64.tar.gz'],
].map(([key, name]) => [key, { url: `https://github.com/${FORK_REPOSITORY}/releases/download/fork-v0.15.7/${name}`, size: 1024, sha256: 'a'.repeat(64) }])) })

describe('personal fork channel', () => {
  test('uses the public release feed without GitHub API quotas or an embedded token', () => {
    expect(FORK_RELEASE_URL).toBe('https://github.com/antoine-berger/craft-agents-oss/releases/latest/download/fork-release.json')
    expect(parseForkRelease(release()).version).toBe('0.15.7')
  })
  test('refuses upstream releases and URL substitution', () => {
    const upstream = release(); upstream.repository = 'lukilabs/craft-agents-oss'
    expect(() => parseForkRelease(upstream)).toThrow()
    const altered = release(); altered.assets['darwin-arm64']!.url = 'https://thecraftagents.com/Craft.zip'
    expect(() => parseForkRelease(altered)).toThrow()
  })
  test('pins the exact versioned asset, not latest or another tag', () => {
    const changed = release(); changed.assets['server-linux-x64']!.url = changed.assets['server-linux-x64']!.url.replace('fork-v0.15.7', 'fork-v0.15.8')
    expect(() => parseForkRelease(changed)).toThrow()
  })
  test('refuses missing checksum, size, or platform artifact', () => {
    const changed = release(); changed.assets['server-linux-x64']!.sha256 = ''
    expect(() => parseForkRelease(changed)).toThrow()
    changed.assets['server-linux-x64']!.sha256 = 'a'.repeat(64); changed.assets['server-linux-x64']!.size = -1
    expect(() => parseForkRelease(changed)).toThrow()
    delete changed.assets['server-linux-x64']
    expect(() => parseForkRelease(changed)).toThrow()
  })
  test('compares version numbers without upgrading equal versions or downgrading', () => {
    expect(isNewerVersion('0.15.7', '0.15.6')).toBe(true)
    expect(isNewerVersion('0.15.10', '0.15.9')).toBe(true)
    expect(isNewerVersion('0.16.0', '0.15.100')).toBe(true)
    expect(isNewerVersion('0.15.6', '0.15.6')).toBe(false)
    expect(isNewerVersion('0.15.6', '0.15.7')).toBe(false)
  })
  test('rejects path traversal, shell syntax and pre-release versions', () => {
    for (const version of ['../../tmp', '0.15.7;reboot', '0.15.7-beta', '01.15.7', '0.15.7/']) {
      const changed = release(); changed.version = version
      expect(() => parseForkRelease(changed)).toThrow()
    }
  })
})
