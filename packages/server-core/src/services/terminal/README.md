# Session terminals

The optional terminal panel opens one interactive shell in the session's prepared Git worktree. It runs on the same workspace server as the agent, with that server user's tools and environment. It is operated by the user, not sent as an agent prompt.

Hiding the panel or losing the connection detaches the viewer and keeps the shell running. Reopening the panel reuses it and replays up to 256 KiB of recent output. **Stop** ends the shell; archiving, deleting, restoring a checkpoint and shutting down the server use the session worktree-resource guards. A checkout must not be removed while its terminal has not acknowledged exit. Detached daemons are outside the terminal's process tree.

The PTY uses node-pty in a Node.js child process, including when Craft itself runs in Bun. Node.js must be available on the server's PATH, or `CRAFT_TERMINAL_NODE` must point to its executable. Embedded Electron uses its own executable with `ELECTRON_RUN_AS_NODE=1`. Missing Node or an unavailable native addon is an explicit terminal error; there is no line-console fallback.

Packaging must include node-pty's native addon and executable spawn helper. Linux installs compile the native addon for the target architecture; Mac packages must preserve the spawn-helper executable bit. No provider credentials are sent to the renderer.
