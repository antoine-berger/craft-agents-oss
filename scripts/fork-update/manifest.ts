import { createHash } from 'node:crypto'
import { createReadStream, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FORK_REPOSITORY, parseForkRelease, versionParts } from '../../apps/electron/src/main/fork-release'
const [version, directory] = process.argv.slice(2)
if (!version || !directory) throw new Error('Usage: bun scripts/fork-update/manifest.ts VERSION DIRECTORY')
versionParts(version)
async function asset(name: string) {
  const path = join(directory!, name)
  const hash = createHash('sha256')
  for await (const block of createReadStream(path)) hash.update(block)
  return { url: `https://github.com/${FORK_REPOSITORY}/releases/download/fork-v${version}/${name}`, sha256: hash.digest('hex'), size: statSync(path).size }
}
const manifest = parseForkRelease({ schema: 1, repository: FORK_REPOSITORY, version, assets: {
  'darwin-arm64': await asset('Craft-Agents-arm64.zip'),
  'server-linux-x64': await asset('craft-server-linux-x64.tar.gz'),
} })
writeFileSync(join(directory, 'fork-release.json'), JSON.stringify(manifest, null, 2) + '\n')
