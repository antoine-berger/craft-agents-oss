import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { appendFile, copyFile, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { startSetupSupervisor, type SetupSupervisor } from './setup-supervisor'

const MAX_CONFIG_BYTES = 16_384
const MAX_LOG_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_SECONDS = 1800

export interface RepositorySetupConfig {
  command: string
  verifyCommand?: string
  copyFiles?: string[]
  timeoutSeconds?: number
}

export interface RepositorySetupState {
  version: 1
  status: 'running' | 'ready' | 'failed' | 'cancelled' | 'skipped'
  fingerprint: string
  checkout: string
  source: string
  attempt: number
  startedAt: number
  finishedAt?: number
  error?: string
  logPath: string
}

export interface RepositorySetupInput {
  /** The selected source checkout, never a newly checked-out PR's setup instructions. */
  repositoryPath: string
  worktreePath: string
  sessionDirectory: string
  /** Session-owned common Git metadata directory; fixtures may use the workspace session parent. */
  leaseDirectory?: string
  projectSetup?: { command?: string; verifyCommand?: string }
  signal?: AbortSignal
  onProgress?: (state: RepositorySetupState) => void
}

function inside(path: string, root: string): boolean {
  const child = relative(root, path)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function command(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_CONFIG_BYTES || value.includes('\0')) {
    throw new Error(`Repository setup ${label} must be a non-empty command.`)
  }
  return value.trim()
}

function parseConfig(value: unknown): RepositorySetupConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid repository setup configuration.')
  const raw = value as Record<string, unknown>
  const result: RepositorySetupConfig = { command: command(raw.command, 'command') }
  if (raw.verifyCommand !== undefined) result.verifyCommand = command(raw.verifyCommand, 'verifyCommand')
  if (raw.timeoutSeconds !== undefined) {
    if (!Number.isInteger(raw.timeoutSeconds) || (raw.timeoutSeconds as number) < 1 || (raw.timeoutSeconds as number) > 86_400) throw new Error('Setup timeoutSeconds must be between 1 and 86400.')
    result.timeoutSeconds = raw.timeoutSeconds as number
  }
  if (raw.copyFiles !== undefined) {
    if (!Array.isArray(raw.copyFiles) || raw.copyFiles.length > 30 || raw.copyFiles.some(path => typeof path !== 'string' || !path || path.includes('\0') || isAbsolute(path) || path.split(/[\\/]/).includes('..'))) throw new Error('Setup copyFiles must contain repository-relative paths.')
    result.copyFiles = raw.copyFiles as string[]
  }
  return result
}

async function jsonFile(path: string): Promise<unknown | undefined> {
  let info
  try { info = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!info.isFile() || info.size > MAX_CONFIG_BYTES) throw new Error(`Repository setup config must be a regular file smaller than 16 KiB: ${path}`)
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { throw new Error(`Invalid JSON in repository setup config: ${path}`) }
}

/** Explicit project settings win; repository config is read only from the owner's source checkout. */
export async function resolveRepositorySetup(input: Pick<RepositorySetupInput, 'repositoryPath' | 'projectSetup'>): Promise<{ config?: RepositorySetupConfig; source: string }> {
  if (input.projectSetup?.command) return { config: parseConfig(input.projectSetup), source: 'project' }
  const craftPath = join(input.repositoryPath, '.craft', 'setup.json')
  const craft = await jsonFile(craftPath)
  if (craft !== undefined) {
    const config = parseConfig(craft)
    return { config: { ...config, verifyCommand: input.projectSetup?.verifyCommand ?? config.verifyCommand }, source: craftPath }
  }
  const conductorPath = join(input.repositoryPath, 'conductor.json')
  const conductor = await jsonFile(conductorPath) as { scripts?: { setup?: unknown } } | undefined
  if (conductor?.scripts?.setup !== undefined) {
    const setup = conductor.scripts.setup
    const setupCommand = Array.isArray(setup) ? setup.map(value => command(value, 'scripts.setup')).join('\n') : command(setup, 'scripts.setup')
    return { config: { command: setupCommand, verifyCommand: input.projectSetup?.verifyCommand }, source: conductorPath }
  }
  if (input.projectSetup?.verifyCommand) return { config: { command: 'true', verifyCommand: command(input.projectSetup.verifyCommand, 'verifyCommand') }, source: 'project' }
  return { source: 'none' }
}

async function storeState(path: string, state: RepositorySetupState): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, path)
}

async function loadState(path: string): Promise<RepositorySetupState | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Repository setup stopped. Send a message to retry.', 'AbortError')
}

/** Copy explicit local environment files without replacing checkout files or following escaping links. */
async function copySetupFiles(config: RepositorySetupConfig, input: RepositorySetupInput): Promise<void> {
  const sourceRoot = await realpath(input.repositoryPath)
  const targetRoot = await realpath(input.worktreePath)
  for (const file of config.copyFiles ?? []) {
    throwIfAborted(input.signal)
    const source = resolve(sourceRoot, file)
    const target = resolve(targetRoot, file)
    if (!inside(source, sourceRoot) || !inside(target, targetRoot)) throw new Error('Setup file escapes its repository.')
    const sourceInfo = await lstat(source)
    if (!sourceInfo.isFile() || !inside(await realpath(source), sourceRoot)) throw new Error(`Setup file is not a regular repository file: ${file}`)
    const targetParent = resolve(target, '..')
    let ancestor = targetParent
    while (true) {
      try {
        if (!inside(await realpath(ancestor), targetRoot)) throw new Error(`Setup target escapes its checkout: ${file}`)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        ancestor = resolve(ancestor, '..')
      }
    }
    await mkdir(targetParent, { recursive: true })
    if (!inside(await realpath(targetParent), targetRoot)) throw new Error(`Setup target escapes its checkout: ${file}`)
    try { await copyFile(source, target, constants.COPYFILE_EXCL) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!(await lstat(target)).isFile()) throw new Error(`Setup target is not a regular file: ${file}`)
    }
  }
}

const inFlight = new Map<string, Promise<RepositorySetupState>>()

async function dependencyFingerprint(checkout: string): Promise<string> {
  const digest = createHash('sha256')
  for (const file of ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock', 'pyproject.toml', 'uv.lock', 'poetry.lock', 'requirements.txt', 'Cargo.lock', 'go.sum']) {
    const path = join(checkout, file)
    let info
    try { info = await lstat(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (info.isFile() && info.size <= 20 * 1024 * 1024) digest.update(file).update(await readFile(path))
  }
  // Recreating an archived checkout at the same path must prepare it again.
  digest.update(String((await lstat(checkout)).birthtimeMs))
  return digest.digest('hex')
}

/** Repeated preparations share work; only a durable matching success skips execution. */
export function ensureRepositorySetup(input: RepositorySetupInput): Promise<RepositorySetupState> {
  const key = resolve(input.sessionDirectory)
  const existing = inFlight.get(key)
  if (existing) return existing
  const operation = prepare(input).finally(() => { if (inFlight.get(key) === operation) inFlight.delete(key) })
  inFlight.set(key, operation)
  return operation
}

async function prepare(input: RepositorySetupInput): Promise<RepositorySetupState> {
  throwIfAborted(input.signal)
  const data = join(input.sessionDirectory, 'data')
  await mkdir(data, { recursive: true, mode: 0o700 })
  const path = join(data, 'worktree-setup.json')
  const logPath = join(data, 'worktree-setup.log')
  const checkout = await realpath(input.worktreePath)
  let resolved: Awaited<ReturnType<typeof resolveRepositorySetup>> | undefined
  let configError: unknown
  try { resolved = await resolveRepositorySetup(input) } catch (error) { configError = error }
  const previous = await loadState(path)
  let logBytes = 0
  let logWrites = Promise.resolve()
  const capture = (chunk: Buffer) => {
    const kept = chunk.subarray(0, Math.max(0, MAX_LOG_BYTES - logBytes))
    logBytes += kept.length
    if (kept.length) logWrites = logWrites.then(() => appendFile(logPath, kept))
  }
  // No configured setup needs no Python runtime. An interrupted run must still hand off its lease.
  const leaseDirectory = input.leaseDirectory ?? join(dirname(input.sessionDirectory), '.worktree-setup-locks')
  const supervisor = resolved?.config || previous?.status === 'running'
    ? await startSetupSupervisor({ leasePath: join(leaseDirectory, createHash('sha256').update(checkout).digest('hex') + '.lock'), checkout,
      repositoryPath: input.repositoryPath, signal: input.signal, onData: capture })
    : undefined
  try {
    return await prepareUnderLease(input, { path, logPath, checkout, resolved, configError, supervisor,
      flushLog: () => logWrites })
  } finally { await supervisor?.close() }
}

async function prepareUnderLease(input: RepositorySetupInput, details: {
  path: string; logPath: string; checkout: string;
  resolved?: Awaited<ReturnType<typeof resolveRepositorySetup>>; configError: unknown;
  supervisor?: SetupSupervisor; flushLog(): Promise<void>;
}): Promise<RepositorySetupState> {
  const { path, logPath, checkout, resolved, supervisor } = details
  throwIfAborted(input.signal)
  // Another server can finish while this worker waits for the OS lock.
  const previous = await loadState(path)
  if (details.configError) {
    const error = details.configError
    const failed: RepositorySetupState = { version: 1, checkout, source: 'configuration', fingerprint: '', logPath, status: 'failed', attempt: (previous?.attempt ?? 0) + 1, startedAt: Date.now(), finishedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }
    await storeState(path, failed)
    input.onProgress?.(failed)
    throw error
  }
  const { config, source } = resolved!
  const dependencies = await dependencyFingerprint(checkout)
  const fingerprint = createHash('sha256').update(JSON.stringify({ version: 1, checkout, source, config, dependencies })).digest('hex')
  if (previous?.fingerprint === fingerprint && (previous.status === 'ready' || previous.status === 'skipped')) return previous
  let state: RepositorySetupState = { version: 1, checkout, source, fingerprint, logPath, status: config ? 'running' : 'skipped', attempt: (previous?.attempt ?? 0) + 1, startedAt: Date.now() }
  await writeFile(logPath, '', { mode: 0o600 })
  await storeState(path, state)
  input.onProgress?.(state)
  if (!config) return state
  try {
    await copySetupFiles(config, input)
    const timeout = config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
    await supervisor!.run(config.command, timeout)
    if (config.verifyCommand) await supervisor!.run(config.verifyCommand, timeout)
    await details.flushLog()
    throwIfAborted(input.signal)
    state = { ...state, status: 'ready', finishedAt: Date.now() }
    await storeState(path, state)
    input.onProgress?.(state)
    return state
  } catch (error) {
    await details.flushLog()
    state = { ...state, status: error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed', finishedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }
    await storeState(path, state)
    input.onProgress?.(state)
    throw error
  }
}
