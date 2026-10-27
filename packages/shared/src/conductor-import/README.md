# Conductor copy importer

Run the standalone script from the repository root on the Mac. No importer UI or automatic migration is installed in the app.

```sh
bun scripts/import-conductor.ts --dry-run
bun scripts/import-conductor.ts --list
bun scripts/import-conductor.ts --session CONDUCTOR_SESSION_ID
bun scripts/import-conductor.ts --all
```

The default is read-only. Only `--all` or `--session` copies chats. `--database`, `--workspace`, `--project` and `--report` select an alternate database, configured remote workspace, existing target project and report path. The script uses the Mac's existing Craft remote connection without printing credentials, writes a private progress report after every chat, and can safely resume by rerunning (identical copies are skipped). Ctrl-C stops between chats. Sessions import sequentially, never loading all histories into memory.

- The script reads SQLite through Python 3, using `mode=ro`, `query_only` and bound query arguments. No native SQLite module is required.
- Metadata pages contain at most 100 chats (the script requests 100). History and attachments are loaded only for a selected chat. SQLite streams use `fetchmany(200)` and reject over 50,000 records or 32 MiB of source data before materializing a chat.
- The portable RPC envelope is capped at 14 MiB to stay below the headless Bun WebSocket limit of 16 MiB. Oversized chats fail explicitly; they are never silently truncated. This importer does not yet provide chunked transfer for larger chats.
- Existing messages, tool inputs/results, turn IDs, timestamps, archive/hidden state and available attachments are copied. SDK lifecycle metadata and unsupported blocks remain in `data/conductor-original.json`. The source SQLite rows and source files are unchanged.
- Attachments are copied only from Conductor's asset stores or the selected database copy's `attachments/`, `assets/` or `session_assets/` subdirectories. Paths outside these roots and symbolic links to files are rejected; filenames become generated portable paths. Individual attachments are bounded to 16 MiB and 1,000 files per chat.
- Import validates the original export's SHA-256 and rebuilds the session instead of trusting supplied paths, SDK IDs or writable session headers. A per-workspace lock plus a source-content-derived session ID makes concurrent identical imports idempotent. A changed source creates a distinct copy and never overwrites a continued Craft chat.
- Projects are reused/created per source repository identity. A caller can explicitly bind to an existing Craft project instead.
- A continuation starts with a new SDK session and a bounded transcript tail (60,000 characters) as prior context. Full saved history remains available in the session. No old SDK resume handle, local Mac cwd, worktree ownership, credentials or running process is transferred. Recognized GitHub repositories become pending selections; an unrecognized repository must be chosen before the first new message. No Git checkout or workflow runs during import.
- Cloud data is only as complete as the local cache. Remote-host metadata marks a source partial; the import report warns that a cloud cache may be incomplete. Missing full cloud history is not fabricated.

The script sends copies over the existing authenticated workspace RPC connection using `conductor:import`. The backend validates the copy and publishes it atomically after attachments have been restored. There are no local Electron migration channels or UI controls.
