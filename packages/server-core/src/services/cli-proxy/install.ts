import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const CLI_PROXY_VERSION = '8.0.44'
const artifacts: Record<string, { name: string; sha256: string }> = {
  'darwin-arm64': { name: 'darwin_aarch64', sha256: '50b75e0bcec8576b93561f2ab2941ff08af26fc9273cf686e9c2b337716bbc46' },
  'linux-x64': { name: 'linux_amd64_no-plugin', sha256: '72b59dc9b79c1f6860031705c9e8d8676dab7cd3caef81009838928c91ab2beb' },
}

export async function installCliProxy(root: string): Promise<string> {
  const artifact = artifacts[`${process.platform}-${process.arch}`]
  if (!artifact) throw new Error('Integrated account management supports Apple Silicon and Linux x64')
  const directory = join(root, 'bin', CLI_PROXY_VERSION)
  const binary = join(directory, 'cli-proxy-api')
  try {
    const expected = (await readFile(join(directory, 'binary.sha256'), 'utf8')).trim()
    if (createHash('sha256').update(await readFile(binary)).digest('hex') !== expected) throw new Error('Account service binary integrity check failed')
    return binary
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const url = `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${CLI_PROXY_VERSION}/CLIProxyAPI_${CLI_PROXY_VERSION}_${artifact.name}.tar.gz`
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) })
  if (!response.ok) throw new Error(`Account service download failed (${response.status})`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Account service archive integrity check failed')
  const archive = join(directory, 'release.tar.gz')
  await writeFile(archive, bytes, { mode: 0o600 })
  await promisify(execFile)('tar', ['-xzf', archive, '-C', directory, 'cli-proxy-api', 'LICENSE'])
  await chmod(binary, 0o700)
  const digest = createHash('sha256').update(await readFile(binary)).digest('hex')
  await writeFile(join(directory, 'binary.sha256.tmp'), digest, { mode: 0o600 })
  await rename(join(directory, 'binary.sha256.tmp'), join(directory, 'binary.sha256'))
  return binary
}
