/** Only this fork's versioned GitHub assets are accepted by the desktop updater. */
export const FORK_REPOSITORY = 'antoine-berger/craft-agents-oss'
export const FORK_RELEASE_URL = `https://github.com/${FORK_REPOSITORY}/releases/latest/download/fork-release.json`

export interface ForkAsset { url: string; sha256: string; size: number }
export interface ForkRelease {
  schema: 1
  repository: typeof FORK_REPOSITORY
  version: string
  assets: { 'darwin-arm64': ForkAsset; 'server-linux-x64': ForkAsset }
}

export function versionParts(version: string): number[] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Expected a stable x.y.z fork version')
  return version.split('.').map(Number)
}

export function isNewerVersion(next: string, current: string): boolean {
  const a = versionParts(next), b = versionParts(current)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  return false
}

export function parseForkRelease(value: unknown): ForkRelease {
  const release = value as ForkRelease
  if (!release || release.schema !== 1 || release.repository !== FORK_REPOSITORY) throw new Error('Invalid fork release')
  versionParts(release.version)
  for (const key of ['darwin-arm64', 'server-linux-x64'] as const) {
    const asset = release.assets?.[key]
    const name = key === 'darwin-arm64' ? 'Craft-Agents-arm64.zip' : 'craft-server-linux-x64.tar.gz'
    const url = `https://github.com/${FORK_REPOSITORY}/releases/download/fork-v${release.version}/${name}`
    if (!asset || asset.url !== url || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new Error(`Invalid fork asset: ${key}`)
    }
  }
  return release
}
