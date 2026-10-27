# Conductor copy importer

Settings → Workspace → Import from Conductor lists the local Conductor database without changing it. The user selects chats, previews them, then explicitly copies them. Sessions import sequentially, never loading all histories into memory. No import runs at application startup.

- Electron reads SQLite through Python 3, using `mode=ro`, `query_only` and bound query arguments. No native SQLite module enters Electron's Node process.
- Metadata pages contain at most 100 chats (the UI requests 50). History and attachments are loaded only for a selected chat. SQLite streams use `fetchmany(200)` and reject over 50,000 records or 32 MiB of source data before materializing a chat.
- The portable RPC envelope is capped at 14 MiB to stay below the headless Bun WebSocket limit of 16 MiB. Oversized chats fail explicitly; they are never silently truncated. This importer does not yet provide chunked transfer for larger chats.
- Existing messages, tool inputs/results, turn IDs, timestamps, archive/hidden state and available attachments are copied. SDK lifecycle metadata and unsupported blocks remain in `data/conductor-original.json`. The source SQLite rows and source files are unchanged.
- Attachments are copied only from Conductor's asset stores or the selected database copy's `attachments/`, `assets/` or `session_assets/` subdirectories. Paths outside these roots and symbolic links to files are rejected; filenames become generated portable paths. Individual attachments are bounded to 16 MiB and 1,000 files per chat.
- Import validates the original export's SHA-256 and rebuilds the session instead of trusting supplied paths, SDK IDs or writable session headers. A per-workspace lock plus a source-content-derived session ID makes concurrent identical imports idempotent. A changed source creates a distinct copy and never overwrites a continued Craft chat.
- Projects are reused/created per source repository identity. A caller can explicitly bind to an existing Craft project instead.
- A continuation starts with a new SDK session and a bounded transcript tail (60,000 characters) as prior context. Full saved history remains available in the session. No old SDK resume handle, local Mac cwd, worktree ownership, credentials or running process is transferred. Recognized GitHub repositories become pending selections; an unrecognized repository must be chosen before the first new message. No Git checkout or workflow runs during import.
- Cloud data is only as complete as the local cache. Remote-host metadata marks a source partial; the UI also warns unconditionally that a cloud cache may be incomplete. Missing full cloud history is not fabricated.
- Preview → Save portable copy exports the version-1 envelope as JSON. Open a saved portable import accepts that envelope and uses the same authenticated server validation. Arbitrary third-party Conductor export formats and the Conductor cloud API are not implemented.

Channels: `conductor:listLocal` and `conductor:exportLocal` stay on the desktop; `conductor:import` uses the existing authenticated workspace RPC connection to the backend. All import calls are workspace-scoped.
