# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits. The in-app loader only reads `X.Y.Z.md` files, so this file is never shown to users.

## Features

- **Independent agent-created chats** — Agents can create a new chat in the same or another project, with its own worktree and runtime. Session tools share a single normal interface; the former Coding system is removed while older conversations retain their history and SDK resume state.
- **Read other chats when needed** — Agents can search and read bounded pages of conversations in their workspace, with project filters and source references instead of loading every history upfront.
- **A native Ship workflow** — Plan, independent checks, explicit human approval, implementation, review, E2E and GitHub feedback run as persistent server tasks. Portable skills replace Mac-specific commands and hooks.
- **Needs you** — A yellow hand beside the session title marks blocking questions, plan decisions, errors and current GitHub review/CI feedback. The list keeps its normal layout, and attention persists while the app is closed.
- **Quota and context indicators** — A compact sidebar control shows separate five-hour and weekly account quotas with manual refresh. The composer shows current context occupancy before the model, with detailed information on demand. Missing and stale provider data remain explicit.

- **Review and restore coding sessions** — Review committed and uncommitted changes against the base branch, attach inline comments to your next message, and restore files plus conversation to a saved turn after creating a recovery backup. PR and CI controls no longer depend on a hidden Coding mode. (#4)
- **Start from existing work** — Choose a branch, GitHub pull request, GitHub issue or connected Linear issue before sending. New branches use your GitHub login and a descriptive task name; occupied branches require an explicit copy. (#4)
- **Browser on the server** — Linux sessions, including existing coding sessions, can browse with a private Chromium profile without a connected Mac. Challenges pause for human intervention; existing desktop cookies stay separate. (#4)
- **Copy Conductor chats with a script** — A standalone migration script copies local Conductor history and attachments into Craft projects without changing the originals. Repeated copies are deduplicated and incomplete cloud caches are identified. (#4)

- **Claude account connectors in Sources** — Native claude.ai MCP connectors appear with their connection status and tools in the source list and chat selector. Authentication and management stay on claude.ai; no duplicate Craft source or connector credential is created.
- **A worktree for every new session** — New independent sessions automatically isolate their repository in a session-owned branch and worktree. Choose a repository when the workspace contains several; project repositories are used automatically. The composer no longer requires a Coding mode toggle. Existing conversations retain their folders.

- **Sign in to MCP servers that reject the OAuth relay** — Some MCP servers only accept a local (loopback) redirect address when signing in, and refuse the Craft Agents relay with an error like "only HTTP loopback callbacks". Add `"oauthRelay": false` to the source's `mcp` block to send the sign-in straight back to the app on `localhost` instead. Leave it unset to keep using the relay. See **Sources → MCP servers → Authentication** in the docs.

## Improvements

## Bug Fixes

- **Chat input stays visible** — Switch the active composer immediately instead of retaining fading forms. An interrupted transition can no longer hide the new input outside the card; height animation and draft handling are preserved.

- **Native linear PR stacks** — Monitor, Ship Plan and Ship preserve the selected parent branch, require native GitHub stack membership and append only to the current top. Dependent tickets form one chain, while unrelated chains can still run in parallel; description-only links and sibling PRs no longer count as stacking.

- **Connectors recover in existing chats** — Refresh the live Claude SDK tool catalog between messages without replacing its process, retain healthy discovery results while retrying failures after five seconds, and pass pilot branch references through `repository.start`. Existing histories and background agents remain attached. (f26c1103)

## Breaking Changes

- **Multiple Claude and GPT accounts** — Connect accounts in AI settings using an integrated CLIProxyAPI service, import existing CLI logins, and pause individual accounts. An optional all-proxy mode also routes legacy chats and claude.ai MCP discovery/tool calls through CLIProxyAPI, making those connectors available to Claude and GPT. (#4)

- **Repository drafts** — The composer suggests only repositories selected before, remembers the last choice, and searches for other repositories on demand. Repository selection is instant: cloning and worktree preparation start with the first message, when the chat also receives its title. (#4)

- **Account-scoped repository search** — Repository search includes personal, collaborator and organization repositories available to the connected GitHub account, including private repositories and forks. Unrelated worldwide results are excluded. (#4)

- **Automatic connectors in every chat** — All available connectors and configured sources are enabled automatically, including in existing chats and after newly connecting a source. The composer no longer asks you to select Claude connectors or sources. (#4)

- **Clear model picker** — GPT connections appear under OpenAI, model families stay together with versions sorted newest first, and menu/button labels consistently show readable names such as Opus 5.5 and GPT 6.1 Sol. (#4)

- **New sessions stay in their project** — The global New Session button inherits the open project info page or selected project filter, even alongside status/label filters. Navigation keeps the new session visible in that project. (#4)

- **Consistent composer after the first message** — Prepared sessions keep the same repository chip as the draft, showing the repository name instead of a generated worktree folder. Branch and checkout paths remain available in read-only details. (#4)

- **Repository logos** — Repository badges and choices show the repository name without the organization prefix, alongside its GitHub owner avatar. Existing worktree sessions use the same presentation. (#4)

- **GitHub branch prefixes** — New session worktrees use the connected GitHub username as their branch prefix, independently of the repository organization. Existing session branches retain their saved names. (#4)

- **Project empty-state creation** — The New Session button inside an empty project list uses the same project-aware creation action as the global button. New drafts appear immediately in that project. (#4)

- **Compact chat controls** — Remove the shortcut hint row and its reserved space, keep a static input prompt, and move Projects above Labels. Chats use Execute without a mode selector, slash-mode commands or keyboard cycling. (#4)

- **Native Claude artifacts** — Opt in to the native Artifact tool for Claude chats; account eligibility and organization policy still apply. CLIProxyAPI inference routing is preserved, so API-key proxy chats still require a supported claude.ai authentication path before they can publish. No Claude Docs integration is enabled.

- **Reliable follow-ups** — Choose Queue or Steer for follow-up messages, use the opposite action with Cmd/Ctrl+Enter, and manage pending messages above the composer. Editing pauses delivery and preserves the main draft and attachments. Pending messages retain their identities and remain durable until their turn actually starts; repeated text and concurrent preparation cannot silently reorder or drop them.

- **PR actions** — Use the numbered merge-queue glyph and shorter action messages, with current PR context and existing push boundaries. Refresh stale PR state without bypassing GitHub quota backoff.
- **Project pilots** — Keep pilots outside global task groups and counters, including All Sessions grouped by status. Their dedicated project location, explicit search and archives stay available.
- **Usage meter** — Refresh the displayed account while the app is visible and after reconnection, and preserve the last known values across temporary errors and remounts without mixing accounts.
