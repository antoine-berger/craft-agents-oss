#!/usr/bin/env bun
/** Explicit, copy-only Conductor migration. No migration is run by the application. */
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { CliRpcClient } from '../apps/cli/src/client'
import { listLocalConductorChats, exportLocalConductorChat } from '../packages/shared/src/conductor-import/reader'
import type { ConductorChatPreview, ConductorImportResult } from '../packages/shared/src/protocol/conductor-import'

export function migrationArguments(args: string[]) {
  const { values } = parseArgs({ args, strict: true, options: {
    help: { type: 'boolean' }, list: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, all: { type: 'boolean' },
    session: { type: 'string', multiple: true }, database: { type: 'string' }, config: { type: 'string' },
    workspace: { type: 'string' }, project: { type: 'string' }, report: { type: 'string' },
  } })
  if (values.all && values.session?.length) throw new Error('Choose --all or --session, not both.')
  return values
}

export async function runConductorMigration(args: string[]) {
  const options = migrationArguments(args)
  if (options.help) {
    console.log('Usage: bun scripts/import-conductor.ts --dry-run | --list | --session ID [--session ID] | --all\nOptions: --database PATH --config PATH --workspace ID_OR_NAME --project ID --report PATH\nThe default is a read-only inventory. Originals are never changed. --all and --session explicitly copy chats.')
    return
  }
  const chats: ConductorChatPreview[] = []
  let cursor: number | undefined = 0
  do {
    const page = await listLocalConductorChats({ databasePath: options.database, cursor, limit: 100 })
    chats.push(...page.chats)
    cursor = page.nextCursor
  } while (cursor !== undefined)
  const requested = new Set(options.session ?? [])
  const selected = requested.size ? chats.filter(chat => requested.has(chat.id)) : chats
  const missing = [...requested].filter(id => !chats.some(chat => chat.id === id))
  if (missing.length) throw new Error(`Unknown Conductor session IDs: ${missing.join(', ')}`)
  if (options.list) {
    for (const chat of selected) console.log(JSON.stringify({ id: chat.id, title: chat.title, repository: chat.repositoryName, archived: chat.archived }))
    return
  }
  if (options['dry-run'] || (!options.all && !requested.size)) {
    console.log(JSON.stringify({ mode: 'read-only', available: chats.length, selected: selected.length, imported: 0, originalsChanged: false }))
    return
  }
  const configPath = options.config ?? resolve(homedir(), '.craft-agent/config.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  const candidates = (config.workspaces as Array<{ id: string; name: string; remoteServer?: { url: string; token: string; remoteWorkspaceId: string } }>).filter(workspace => workspace.remoteServer)
  const workspace = options.workspace
    ? candidates.find(workspace => workspace.id === options.workspace || workspace.name === options.workspace || workspace.remoteServer?.remoteWorkspaceId === options.workspace)
    : candidates.find(workspace => workspace.id === config.activeWorkspaceId) ?? (candidates.length === 1 ? candidates[0] : undefined)
  if (!workspace?.remoteServer) throw new Error('Select a configured remote workspace with --workspace. No credentials need to be copied into the script.')
  const remote = workspace.remoteServer
  const client = new CliRpcClient(remote.url, { token: remote.token, workspaceId: remote.remoteWorkspaceId, requestTimeout: 180_000 })
  const reportPath = resolve(options.report ?? `conductor-import-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  const report: { startedAt: number; workspaceId: string; results: Array<{ id: string; status: string; sessionId?: string; warnings?: string[]; error?: string }> } = { startedAt: Date.now(), workspaceId: remote.remoteWorkspaceId, results: [] }
  let stopped = false
  const stop = () => { stopped = true }
  process.on('SIGINT', stop)
  try {
    await client.connect()
    for (const chat of selected) {
      if (stopped) break
      try {
        const bundle = await exportLocalConductorChat(chat.id, { databasePath: options.database })
        const result = await client.invoke('conductor:import', remote.remoteWorkspaceId, bundle, { projectId: options.project }) as ConductorImportResult
        report.results.push({ id: chat.id, status: result.status, sessionId: result.sessionId, warnings: result.warnings })
      } catch (error) {
        // Reader and server errors are sanitized; never log subprocess stdout/stderr or connection configuration.
        report.results.push({ id: chat.id, status: 'failed', error: error instanceof Error ? error.message : 'Import failed' })
      }
      await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 })
      const latest = report.results.at(-1)!
      console.log(JSON.stringify({ completed: report.results.length, total: selected.length, id: latest.id, status: latest.status }))
    }
  } finally {
    process.removeListener('SIGINT', stop)
    client.destroy()
  }
  const counts = report.results.reduce<Record<string, number>>((counts, result) => { counts[result.status] = (counts[result.status] ?? 0) + 1; return counts }, {})
  console.log(JSON.stringify({ ...counts, pending: selected.length - report.results.length, report: reportPath, originalsChanged: false }))
  if (counts.failed || stopped) process.exitCode = 1
}

if (import.meta.main) runConductorMigration(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : 'Migration failed'); process.exitCode = 1 })
