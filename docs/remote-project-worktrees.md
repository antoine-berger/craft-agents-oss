# Project worktrees on a remote server

Projects organize initiatives, not unique repositories: “Checkout redesign” and “Search improvements” can both use the same repository. Each new chat can receive its own Git branch and worktree. The desktop or browser displays Craft's UI; agents, Git and tools run on the connected workspace server.

## Set up an initiative

1. Connect to the server, then open the project's **Settings**.
2. Set **Working directory** to the repository on that server. **Choose…** browses the server when connected remotely. The repository needs a commit, and the server user needs write access to it and the directory where neighboring worktrees are created.
3. Enable **New worktree for each chat**. Optionally set **Base branch** to an existing branch such as `main` or `origin/main`; leave it blank for the repository default.
4. Save, then use **New session in …** from the project.

The worktree is created before the agent starts on the first message. Empty chats do not create checkouts. Subsequent messages and resumed chats reuse the same branch and directory. Settings are captured when a new chat is created; existing chats are not migrated. Child sessions, conversation forks and task sessions retain their existing directory behavior.

Choosing an explicit folder before the first message opts that chat out of automatic worktrees. After worktree preparation starts, the folder is locked for that chat; start another chat to use a different folder.

### Archive and delete

**Remove clean worktrees on archive** is off by default. When enabled, archiving can remove the checkout while keeping its branch and commits. The next message in a resumed chat recreates the checkout from that branch.

Cleanup skips active or queued work, checkouts used by another chat, locked worktrees, local changes, untracked files and ignored files. Git index flags that hide changes also prevent removal. Archiving still succeeds when cleanup is skipped. Deleting a chat keeps its existing checkout and branch; it does not trigger cleanup.

When Git refuses cleanup, the chat receives a notice with the retained path and reason. References from another chat's subdirectory or symbolic link also keep the checkout alive.

## Run this checkout on Linux

Install Bun and Git, then run these commands from the repository root on the server:

```bash
bun install --frozen-lockfile
bun run packages/server/src/index.ts --generate-token
CRAFT_SERVER_TOKEN='paste-generated-token' bun run server:prod
```

`server:prod` builds the Pi subprocess and browser UI, then serves the UI and WebSocket API together on port `9100`. Login uses the server token unless `CRAFT_WEBUI_PASSWORD` is set. Keep the token stable between restarts. Use a service manager for a persistent server process.

If the browser build reaches Node's heap limit, prefix the build/start command with `NODE_OPTIONS=--max-old-space-size=4096` (the tested WebUI build used this setting).

The default listener is `127.0.0.1`. Connect through a tunnel or configure remote binding and TLS using the [remote-server instructions](../README.md#remote-server-headless). For direct network access, the existing settings are `CRAFT_RPC_HOST`, `CRAFT_RPC_TLS_CERT` and `CRAFT_RPC_TLS_KEY`.

For the desktop UI, run this checkout on the client with the server's URL and token:

```bash
CRAFT_SERVER_URL='wss://your-server:9100' \
CRAFT_SERVER_TOKEN='paste-generated-token' \
bun run electron:start
```

This starts the desktop as a thin client; agent execution stays on Linux.

### Packaged Linux server

Build on the matching Linux architecture so the installed native dependencies match the target:

```bash
bun run server:build:linux-x64
# On an ARM64 server, use: bun run server:build:linux-arm64
CRAFT_SERVER_TOKEN='paste-generated-token' ./dist/server/start.sh
```

The build creates `dist/server/` and a versioned `dist/craft-server-<version>-linux-<arch>.tar.gz`. The packaged server supports the desktop client. This build script does **not** include the browser UI: use `server:prod` above, or separately build `bun run webui:build` and set `CRAFT_WEBUI_DIR` to the deployed web assets directory.

## Claude connections

For Claude OAuth accounts, MCP connectors are managed only on **claude.ai** and supplied directly by the SDK. Do not recreate or authenticate them as Craft sources. The chat's source picker links to claude.ai and lists only additional API/local sources; it does not enumerate native connectors or claim they are connected. Existing Craft MCP configurations remain available to other connection types. Craft's internal session tools remain enabled.

Reconnect each Claude OAuth account once to obtain the added `user:mcp_servers` scope; refreshing an old token does not add it. Accounts missing their own saved credentials must reconnect instead of borrowing another account's token. Actual authenticated MCP access has not been validated end to end with user credentials here.

Craft preserves the scopes actually granted during OAuth and pins the account's token and scopes to each agent process. Native connector calls use their SDK provenance and tool schemas; they do not trigger Craft source activation or authentication. Session permission checks still apply. A session whose account cannot authenticate stops before starting the model backend.

## Validation

From the repository root:

```bash
bun test packages/shared/src/projects/__tests__ \
  packages/server-core/src/services/coding-repos \
  packages/server-core/src/sessions/session-worktree-lifecycle.test.ts \
  packages/server-core/src/sessions/session-worktree-paths.test.ts \
  packages/server-core/src/sessions/auth-retry-runtime.test.ts \
  packages/shared/src/auth/__tests__/claude-oauth-scope.test.ts

# Run account/config integration tests in their own processes.
bun test ./packages/shared/src/auth/__tests__/state-multi-connection.isolated.ts
bun test ./packages/shared/src/agent/__tests__/claude-auth-pinning.isolated.ts
bun test ./packages/server-core/src/handlers/rpc/onboarding-scopes.isolated.ts
bun test ./packages/server-core/src/sessions/claude-ai-source-policy.isolated.ts
bun test ./packages/shared/src/agent/__tests__/session-tools-mcp-management.isolated.ts
bun test ./packages/shared/src/agent/core/__tests__/pre-tool-use-checks.isolated.ts

bun test packages/shared/src/agent/core/__tests__/claude-ai-mcp-provenance.test.ts \
  packages/shared/src/config/__tests__/llm-connections-auth-env.test.ts \
  packages/shared/src/agent/__tests__/claude-subprocess-env.test.ts \
  packages/session-tools-core/src/handlers/source-management-policy.test.ts
bun test packages/shared/src/prompts/__tests__/system.test.ts \
  packages/shared/src/agent/core/__tests__/prompt-builder.test.ts \
  packages/shared/src/agent/__tests__/prompt-builder-context-split.test.ts

bun run typecheck:all
NODE_OPTIONS=--max-old-space-size=4096 bun run webui:build
bun run lint:i18n:sorted
bun run lint:i18n:parity
bun run lint:i18n:coverage
```

Git tests use temporary local repositories and cover persistence, separate chats, resume, cleanup and ownership checks. They do not exercise a live model account or deploy to your server.
