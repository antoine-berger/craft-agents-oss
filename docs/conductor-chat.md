# Chat presentation

The interactive chat uses the Conductor 0.92.0 desktop conversation as its visual reference. The renderer keeps Craft's sessions, worktrees, provider routing, permission policy and message history. It does not run Ship in separate chats or introduce a workflow board.

The `chat` appearance is explicit on the interactive transcript and composer. Document previews, Pages, embedded edit prompts and the read-only viewer keep their existing appearance. Shared Markdown, tool parsers, file actions, annotations and checkpoint callbacks are reused.

## Preserved preferences

- Execute only; no permission-mode button or keyboard-help footer.
- A fixed input placeholder and automatic connectors.
- The existing compact model menu, on the right, with the context ring immediately to its left.
- No percentage beside the context ring.
- Existing queue/steering delivery and Stop semantics. The visual change does not add editing or deletion of queued messages.

## Reference and verification

Reference: the installed Conductor **0.92.0** desktop assets. The following SHA-256 hashes identify the distributed code used for the comparison:

| Asset | SHA-256 |
| --- | --- |
| `renderApp-BBRm1hiD.js` | `abf18c67b40f4d51d2a793cd164297378bdda1bda9966e5766ec6e168bc09f80` |
| `main-DkBMmrtL.js` | `9bdf464de0e675fb78d8b6508c142ca15e45a999e1f0759f73f5d1d4a4dcd316` |
| `index-C0NH49rF.css` | `23fad83f1b41bdae6a37931f079032781fa57bf9ca030c938a991076fe5e5b1a` |

The assets were decompressed from the installed native binary and compared byte for byte. They are compiled JavaScript/CSS, not the original TypeScript sources. Those proprietary bundles and private chat screenshots are not included in this repository.

Validate the real `ChatDisplay` with synthetic messages, not a replacement mock chat. Compare the same content, theme, viewport, font and zoom. Cover collapsed/expanded work, inline tools, child agents, code/tables, permissions/questions, errors, a running draft, history loading and returning to a previous reading position. Check both geometry and interaction; matching palette values alone does not establish chat parity.

The Conductor palette is bundled as a preset. This feature does not change the user's selected theme.

The chat-only monospace font is the unmodified Geist Mono 1.401 used by the reference. Its SHA-256 is `c7ae9c9e1bf619106fae44b0b01834edb8f763ac92beae2c19660f8e15095872`. Copyright and SIL OFL 1.1 are included beside the font and in bundled `docs/font-licenses.md`.

## Completed validation

See the [comparison and review report](conductor-chat-validation/README.md) for screenshots, computed measurements, focused checks and explicit limits. Questions use an equivalent session MCP tool because the native SDK question callback is not available in the existing execution policy. Actual owner responses, cancellation and reconnects are handled by the server; no approval is inferred from agent messages. Optional reasoning and usage fields preserve provider-supplied data without changing routing.
