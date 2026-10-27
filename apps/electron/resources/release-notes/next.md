# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits. The in-app loader only reads `X.Y.Z.md` files, so this file is never shown to users.

## Features

- **Claude account connectors in Sources** — Native claude.ai MCP connectors appear with their connection status and tools in the source list and chat selector. Authentication and management stay on claude.ai; no duplicate Craft source or connector credential is created.
- **A worktree for every new session** — New independent sessions automatically isolate their repository in a session-owned branch and worktree. Choose a repository when the workspace contains several; project repositories are used automatically. The composer no longer requires a Coding mode toggle. Existing conversations retain their folders.

- **Sign in to MCP servers that reject the OAuth relay** — Some MCP servers only accept a local (loopback) redirect address when signing in, and refuse the Craft Agents relay with an error like "only HTTP loopback callbacks". Add `"oauthRelay": false` to the source's `mcp` block to send the sign-in straight back to the app on `localhost` instead. Leave it unset to keep using the relay. See **Sources → MCP servers → Authentication** in the docs.

## Improvements

## Bug Fixes

## Breaking Changes

- **Multiple Claude and GPT accounts** — Connect accounts in AI settings using an integrated CLIProxyAPI service, import existing CLI logins, and pause individual accounts. An optional all-proxy mode also routes legacy chats and claude.ai MCP discovery/tool calls through CLIProxyAPI, making those connectors available to Claude and GPT. (#4)

- **Repository drafts** — The composer suggests only repositories selected before, remembers the last choice, and searches for other repositories on demand. Repository selection is instant: cloning and worktree preparation start with the first message, when the chat also receives its title. (#4)
