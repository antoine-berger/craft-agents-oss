# Worktree tools

The conversation stays the main surface. Open **Worktree tools** in the chat header, or press **Cmd+Shift+B** (Ctrl+Shift+B on Windows/Linux), to show files and a terminal beside it. In a narrow chat panel, tools temporarily cover the conversation; closing them returns to the same chat.

## Files

Files come from the session's actual Git checkout, separately from attachments and plans stored in the chat directory. Folders load on demand. Enter a repository-relative path to open a file, and use **Line → Go** to reach a line.

Choose **Edit**, then **Save**. If another process changed the file, the save is refused and the draft stays available. Closing and reopening the panel retains drafts in memory; quitting or reloading the app does not. Existing UTF-8 files up to 512 KiB can be edited. Binary files, symbolic links and files with mixed line endings are preview-only or explicitly unavailable. Archived chats allow inspection, but cannot save edits.

## Terminal

The shell runs on the workspace server, inside the selected session's existing checkout. Hiding the panel preserves the shell and bounded scrollback; reopening or reconnecting reattaches to it. **Stop** ends the shell and its jobs. Archiving and deleting a chat wait for terminal shutdown, and a live terminal prevents checkpoint restoration in that checkout.

Interactive terminals use `node-pty` in a Node host. The Electron app uses its embedded Node runtime. A Bun-based headless server needs Node.js on its PATH, or an explicit `CRAFT_TERMINAL_NODE` executable. On Linux, installing `node-pty` also requires the native build prerequisites provided by its install script. Missing prerequisites produce a terminal error rather than a simulated console.

## Setup and checkpoints

Configure preparation and readiness commands in Project settings, or use the repository configuration described in [Repository setup](repository-setup.md). A configured setup must succeed before the agent starts. An absent command is reported as skipped; Craft does not infer arbitrary installation commands or claim that dependencies are ready.

For imported chats with an existing checkout, **Session info → Enable future checkpoints** associates that checkout without moving files, changing branches or replacing history. This creates no checkpoints for past turns. If the checkout is unsupported, the reason remains visible. Associated imported checkouts are never automatically removed or recreated.

## Branches and activity

[Branch stacks](branch-stacks.md) record explicit parent branches and report when local ancestry needs attention. Refreshing these details never fetches, rebases, pushes or launches another chat.

Session rows can show cached tracked-line additions and deletions. Counts refresh after an agent turn, not once per rendered row. Their tooltip includes the observation time and comparison commit. Untracked and ignored files are excluded; unavailable counts stay hidden.

Reviewer usage in Session info measures Codex helper attempts only, including failed attempts with available usage. It separates requested and reported models. Native Claude steps and the selected pool account are not inferred from timing or quota changes.
