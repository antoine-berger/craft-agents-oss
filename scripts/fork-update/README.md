# Personal Craft fork updates

The existing Update button uses only
`https://github.com/antoine-berger/craft-agents-oss/releases/latest/download/fork-release.json`.
No official Craft update, GitHub API token, timer, startup check or quit-time install.

## Publish

Commit the intended app/server changes to the fork first. In GitHub Actions, run
**Fork release** on that commit/branch with a new stable version, e.g. `0.15.7`.
Both builds must succeed before publication. The immutable `fork-vVERSION` release
contains the Apple Silicon app ZIP, Linux x64 server source distribution, and the
shared SHA-256/size manifest. Reusing a version fails rather than replacing assets.
A merge alone never publishes or deploys anything.

Release inputs must preserve the consolidated baseline in `release-base.lock.json`.
The workflow checks the source tree before building, then checks the actual Mac ZIP
and server tarball before publishing. Renderer checks follow only the JavaScript
reachable from `index.html` and verify its source maps; copying new TypeScript next
to an old compiled renderer cannot pass. An intentional edit to a pinned file needs
review, focused regression tests and an explicit lock update. Never regenerate the
lock from an older release archive. The guard does not install or restart anything.

## Install

Settings → About → Check for updates downloads and verifies the app and prepares
the server on disk. Install opens a native choice between Mac and server.
The server has a second explicit restart confirmation: **Installer** requires idle
sessions; **Forcer et redémarrer** interrupts active agents and commands.
Cancelling either dialog does nothing. No server update RPC is exposed to agents.

The Mac uses a small local installer because this personal build has an ad-hoc
signature rather than an Apple Developer certificate. Archives must have the
expected bundle ID, version, valid code signature, exact release URL and checksum.
It retains the old bundle next to the app and backs up `~/.craft-agent` in
`~/Library/Caches/antoine-craft-updates/VERSION/` before replacing it.
Existing app identity and data paths are retained to preserve the thin-client setup.

## Server setup

Install `server.py` root-owned, mode 0755, as `/usr/local/sbin/craft-fork-update`.
The desktop reads a private `~/.craft-agent/fork-update.json`:

```json
{"host":"root@10.0.0.160","jump":"proxy"}
```

SSH uses the Mac's existing config/keys, BatchMode, and strict known-host checks.
No private key, provider token or RPC token is put in a release or saved in this file.

`check` is read-only; `stage` downloads to `/var/cache/craft-fork-update` and installs
isolated dependencies in `/home/craft/releases/fork-VERSION`. Neither edits a running
release, service configuration, data, projects or worktrees. Dependency installation
runs as `craft`, never root. It requires the existing Bun runtime, Python >=3.12,
rsync and the server's normal outbound network access.

`apply VERSION SHA256 --authorize-restart` requires an authenticated idle RPC and
no remaining agent/shell/build processes in the service cgroup. Wait for the
five-minute idle Claude expiry if idle runtimes still exist. It backs up data and
service configuration under `/var/backups/craft-fork-VERSION-TIMESTAMP`, checks idle
again, stops the service, finishes the consistent backup and switches an isolated
systemd override. The previous release and `/etc/craft-agents.env` remain intact.
A failed authenticated health check restores the previous override and starts the
old release. The updater never merges, migrates or removes projects/worktrees.

Adding `--force` bypasses only the activity checks after explicit restart consent.
RPC health, archive verification, both backups and rollback remain required.
The service flushes conversation history on shutdown; in-flight commands are
interrupted, not guaranteed to resume. A busy normal install stays ready with
an inline status in Settings instead of another modal.

The root helper is intentionally outside the running backend: installing this
updater does not require restarting that backend. Updating the helper itself is a
separate administrator operation, never a side effect of checking for updates.

## Verification

```sh
bun test apps/electron/src/main/__tests__/fork-release.test.ts
bun test ./apps/electron/src/main/__tests__/fork-update.isolated.ts
python3 -m unittest discover -s scripts/fork-update -p 'test_*.py'
```

A real server stop/start is deliberately excluded from these checks; it needs the
owner's explicit restart authorization.
