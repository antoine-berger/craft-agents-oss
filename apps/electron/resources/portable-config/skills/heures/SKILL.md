---
name: heures
description: Calcule mes heures de travail depuis tous mes chats Craft, imports Conductor inclus, Slack, Calendar et Git local, puis affiche le même diagramme HTML déterministe par tranches de 15 minutes.
argument-hint: "[YYYY-MM-DD | lundi…dimanche]"
disable-model-invocation: true
---

# /heures

Run in this CURRENT chat on the server. Do not create another session/worktree, start a Ship workflow, or change Craft source. Answer a question without executing the command. Use the current CLIProxyAPI-backed chat; no other model runner is needed.

## Absolute rules

- The original generator is `/home/craft/.claude/heures/gen.mjs`. It is copied byte for byte from Antoine's Mac, SHA-256 `3129df6bacf2bc01570aacd1250ad0d76f1a95c9d2cc2bce087d317f05a8c8b3`. **Never edit or regenerate it.** If unavailable/changed, stop and report it.
- All classification, totals, descriptions, table, timeline, colors and layout come from this generator. The adapter changes only the source wording from Conductor to Craft. Do not recreate the chart or calculate alternative totals yourself.
- Only judgment allowed: naming a NEW raw label in `/home/craft/.claude/heures/names.tsv`. An existing label is never renamed. Reuse an existing short chantier name whenever possible. Same inputs and name cache give the same result.
- Read histories/repositories/MCPs only. No Git fetch/pull/push, branch changes, GitHub/Linear/Slack/calendar writes, database writes or browser automation. Only write this command's CSV/cache/report files and the current session's data artifact.
- Keep the Mac's originals intact. Server output is independent. Do not use Mac paths, BSD `date`, `open`, or the old Conductor SQLite database on Linux.

## 1. Resolve the day and collect Craft/Git

Use `/usr/local/bin/python3 /home/craft/.craft-agent/workspaces/cloud/skills/heures/scripts/heures.py` for the following commands (abbreviated `HEURES` below; this is not a separate executable).

```sh
/usr/local/bin/python3 /home/craft/.craft-agent/workspaces/cloud/skills/heures/scripts/heures.py window "<argument, or empty>"
```

Read the returned `date`, `timezone`, `startISO`, `endISO`, `startEpoch`, `endEpoch`. The server configuration preserves Antoine's Mac timezone, currently America/Panama; never use the server's UTC calendar implicitly. The day is 04:00–04:00 with the original 96 quarter-hour buckets. Before 05:00, the default date is yesterday. A weekday means its last strictly past occurrence.

Then run `HEURES collect "<resolved YYYY-MM-DD>"`. This reads all Craft sessions, including archived/hidden sessions and original Conductor subchats retained during import. It deduplicates original message IDs and skips symlink aliases. Hidden system nudges and matched agent-to-agent deliveries are not human actions. Native human messages are active work; assistant/tool activity is waiting. It reads local Git logs only, deduplicates shared repositories/commits, and excludes Claude/Codex-coauthored commits from manual activity.

Output directory: `/home/craft/.claude/heures/<date>/`. `collection.json` contains source/count evidence. `conductor.csv` is the legacy input filename expected by the unchanged renderer; its data now comes from Craft, not the Mac database. Never replace it with a guessed summary. Existing inputs/reports are backed up under `.history/` before replacement.

## 2. Collect optional MCP sources into sorted TSV files

Discover the connected tools with ToolSearch when necessary. Use the exact resolved window. These calls are read-only; do not reconnect or ask for credentials if a source is unavailable. Never fabricate events. An available source with no results gets an empty CSV; an unavailable/incomplete source is skipped with `HEURES collect "<date>" --skip-source slack` and/or `--skip-source calendar` before rendering, which preserves any older file in `.history/` and marks the current source absent. Do not silently reuse a previous partial fetch.

### Calendar: `calendar.csv` (startISO TAB endISO TAB title)

Use connected Google Calendar `list_events` or its equivalent, `startTime=startISO`, `endTime=endISO`, event type DEFAULT, `timeZone=timezone`. Paginate the complete window. Keep only timed events with `start.dateTime`, where self has not declined and transparency is not transparent. Replace tabs/newlines in titles with spaces. Sort by startISO, then endISO/title; deduplicate identical rows. No all-day events. Write only these TSV rows, no header.

### Slack: `slack.csv` (epoch TAB channel)

Resolve Antoine's user by email `antoine.berger@sapiom.ai` through Slack search/users. Search messages from that user on the resolved date and the next date to cover midnight–04:00. Paginate available results, keep only `startEpoch <= integer(ts) < endEpoch`, and use the channel name. Replace tabs/newlines with spaces; sort numerically and deduplicate. No CSV header. If access/rate limits prevent complete collection, mark the source skipped rather than claim it is complete.

## 3. Stable chantier labels

Read `<date>/missing-labels.txt` and the existing `names.tsv`. For each genuinely new label, read the relevant ticket/PR metadata only when needed: SAP/AGENT IDs via Linear; PR number via read-only GitHub metadata. Group obvious matching labels with an existing chantier. Use 1–3 English words, without ticket IDs or ship/plan, e.g. `LLM Gateway`, `Outbound HTTP door`, `PR reviews`. Leave an ambiguous label raw instead of guessing.

Before changing `names.tsv`, preserve a copy under `.history/`. Append only labels absent from its first column, never rename an existing one; then sort by raw label with `LC_ALL=C`. Do not modify the generator to customize names.

## 4. Render and return the exact summary

Use `get_session_info` or the current session context to obtain this session's real data directory. Run:

```sh
/usr/local/bin/python3 /home/craft/.craft-agent/workspaces/cloud/skills/heures/scripts/heures.py render "<date>" --output "<current session data directory>/heures-<date>.html"
```

The adapter invokes the immutable generator with the configured timezone and copies its HTML to the current session. Do not open a Linux desktop/browser or create a public URL/Page. Return its stdout **verbatim** in a code block, with no extra analysis/recomputed totals. If it reports no activity, return that message and no stale preview.

Otherwise show the generated file using Craft's existing HTML preview (replace both values with actual values):

```html-preview
{"src":"<absolute current session data path>/heures-<date>.html","title":"Heures — <date>"}
```

Also include one clickable link to the same HTML for opening/downloading the original file. No custom UI, dashboard redesign or new session. Missing optional sources are already shown as ✗ in the summary.
