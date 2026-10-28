# Prepare new session worktrees

New independent sessions, including a project's pilot, finish their configured setup **before an agent or reviewer starts**. A configured setup failure blocks the first model request. Stop and Archive cancel the setup process group; sending again retries in the same checkout. Existing and imported conversations are not prepared automatically.

Set **Setup command** and optionally **Readiness check** in the project's Settings. These values are captured for new sessions; editing them does not rewrite existing sessions. The command runs at the new worktree's root, even when the project's working directory is a subdirectory.

Alternatively, place `.craft/setup.json` in the selected source checkout:

```json
{
  "command": "corepack pnpm install --frozen-lockfile",
  "verifyCommand": "node --version && test -f .env && pnpm exec tsc --version",
  "copyFiles": [".env"],
  "timeoutSeconds": 1800
}
```

Configured setup uses Python 3's standard library on Linux/macOS for process supervision and an OS checkout lock. Install Python 3 on the workspace server or set `CRAFT_SETUP_PYTHON` to its executable. No Python dependency is required when setup is unconfigured. The example additionally assumes Node, Corepack and the project's required runtime versions are installed. Use your actual repository's dependency, service and toolchain preparation commands; Craft does not guess or silently substitute a package manager. Include checks for every required local service and environment value in `verifyCommand`. Commands must finish; use a service manager or Docker for persistent services rather than leaving detached background shell jobs. Neither command should start the agent or request human interaction.

Explicit project commands take precedence. Otherwise Craft reads `.craft/setup.json`, then the existing `conductor.json` `scripts.setup` command (a string or array). Setup configuration is read from the selected source checkout, not from a newly checked-out PR that might replace it. A project readiness check can also supplement the repository's setup command.

`copyFiles` explicitly copies regular repository-relative files from that source checkout. Existing target files are retained; escaping paths and symlinks are refused. Keep `.env` ignored by Git. There is no automatic copy of credentials or local environment. The server environment is inherited and `CRAFT_REPOSITORY_PATH` / `CONDUCTOR_ROOT_PATH` name the source checkout, while `CRAFT_WORKTREE_PATH` / `CONDUCTOR_WORKSPACE_PATH` name the isolated worktree.

Setup is skipped explicitly when no command is configured; this does **not** assert that dependencies are ready. Successful setup is reused for the same checkout, configuration and dependency manifests. An OS lock serializes setup across server processes, including the command's lifetime if its supervisor dies. If the server crashes, its worker detects the closed pipe and stops its command before releasing the checkout. A failed, cancelled or interrupted attempt is retried only after the previous process is terminal; a changed setup configuration, dependency lockfile or recreated checkout invalidates its cached success. Setup scripts should therefore be idempotent.

Each session keeps private `data/worktree-setup.json` status and `data/worktree-setup.log` output. Progress appears as ordinary chat information, and failures identify the log path. Commands have a configurable timeout (1–86400 seconds, default 1800); output is bounded to 1 MiB per attempt. Avoid echoing secrets in setup scripts.
