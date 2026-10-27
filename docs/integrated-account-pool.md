# Integrated Claude and GPT accounts

In **Settings → AI → Claude and GPT accounts**, enable the account manager, import existing accounts, or add Claude / GPT accounts with browser sign-in. Each account can be paused independently. Choose **Claude · Account pool** or **GPT · Account pool** in the model selector after connecting accounts. Existing default connections are preserved.

The application manages a CLIProxyAPI 8.0.44 child process on the machine running the Craft backend. Thin clients use the Linux backend; desktop-only installations use their local backend. No separate terminal, public proxy port, or manually entered proxy key is needed. Account routing uses round robin with session affinity. CLIProxyAPI owns provider refresh, quota fallback, and account selection.

The native Claude connection remains available for claude.ai MCP connectors. Account-pool connections provide model inference; they do not inherit that account's claude.ai MCP connectors.

## Sign-in and import

Browser sign-in opens the provider's own HTTPS authorization page. The desktop accepts the standard loopback callback (Claude: 54545, Codex: 1455), checks its state, and forwards it over the authenticated Craft RPC connection. OAuth flows are bound to their initiating RPC client and expire after five minutes. A port occupied by another CLI login must be freed before retrying.

**Import existing accounts** copies the backend's native Craft Claude credentials and, on desktop, available local Claude CLI profiles (`.claude`, `.claude-alt`, `.claude-third`) and the current Codex login. macOS Claude credentials are read from Keychain. Imports preserve original files and Keychain entries, skip existing pool identities, and never overwrite a pool's refreshed credentials. An expired or revoked login may require a fresh browser sign-in. Provider token refresh rules also apply to copied CLI grants.

## Runtime and data

- Supported backend targets: macOS Apple Silicon and Linux x64.
- The first enable downloads a pinned official CLIProxyAPI release. Its archive SHA-256 is checked before extraction; subsequent launches verify the installed binary digest. The upstream MIT license is retained beside the binary.
- The backend stores service state, configuration, private logs, and account files under `~/.craft-agent/cli-proxy/` (or the configured Craft data root). Directories are owner-only; configuration, account imports, and keys remain private. Internal management/client keys are generated in Craft's credential vault.
- Both model and management endpoints bind to loopback. Both require keys; the control panel, discovery broadcast, plugin support on Linux, and panel auto-updates are disabled. Browser renderers receive sanitized account labels/status and model names, never tokens or service keys.
- Enabling persists across backend restarts. Craft starts and supervises the child process. Disabling stops the service and retains all account data. Existing sessions and connections are not removed.

## Validation

Manager tests check sanitized account output, RPC-client OAuth ownership, and authorization destination restrictions. A disposable runtime probe checks the actual pinned binary, loopback authentication, private configuration, and OAuth cancellation without signing into an account. Live deployment validation separately covers imported account inference, native MCP discovery, and restart persistence.
