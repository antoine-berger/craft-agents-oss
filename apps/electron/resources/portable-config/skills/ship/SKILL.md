---
name: ship
description: Resume an explicitly started native Craft Ship workflow after plan approval, with implementation, draft PR, independent reviews, E2E and bounded GitHub feedback rounds. Never merges.
disable-model-invocation: true
---

# Ship in Craft

Use the native Ship controls or `/ship` in the chat attached to its Task. No argument is needed: the server binds the current session, project, workflow and isolated Linux worktree. Without an approved plan, direct the owner to `/ship-plan ISSUE-123`. Never infer approval from conversation, edit workflow JSON, forge a reviewer output, or run the old Mac CLI.

- Build only the human-approved plan, preserve unrelated work and follow the repository's conventions. Keep/update the plan in the PR. Run scoped foreground tests with a timeout and at most two workers. Commit owned paths, push this run's existing branch, create/reuse one draft PR in English. Never merge or enqueue. Do not start the dev stack, detached processes or hidden workflows.
- Independent reviewers inspect concrete bugs/security, factual comments and performance/production implications. Use available configured GPT/Codex connections for code/omissions/bug/comment review, Claude for production/MCP review. Reviewers do not edit; their native Task outputs, not the pilot's answer, feed deterministic gates. Fix real findings, counter only with verified current evidence, ask on unresolved product decisions. Correct true comment-style findings too. Three consecutive failed review rounds require a human decision.
- Independent E2E proves every C-numbered contract line at the exact current head. Use disposable local boundaries and cleanup only owned resources. Missing stack/access is BLOCKED; do not fabricate proof. DEFERRED is allowed only for `(post-merge)` contract items. A code change requires a fresh review. Two consecutive E2E failures require the owner.
- The server alone marks the draft ready automatically once review and E2E both pass for the exact current PR head and plan hash. Do not ask for a duplicate publication approval, call `gh pr ready` yourself, merge, enqueue or enable auto-merge.
- Each subsequent `/ship` requests one feedback round: read all bot threads, human review/comment bodies (including approval bodies), required red CI and base conflicts. For bot threads choose FIX / verified COUNTER / searched FOLLOW-UP / concrete out-of-scope IGNORE / product ASK. Fix and test before the authorized bot reply/resolution. Do not reply to or resolve human threads; provide English drafts to the owner. Rebase a conflicting base, never merge it; use an observed remote-head force-with-lease. Never post `/review` or `/claude-review`; `@claude` is the only review-request mechanism.
- After feedback, stop. Native refresh reads CI/reviews without a polling model or automatic new agent. Four user-requested feedback rounds are the bound. Missing/partial GitHub evidence stays blocked. A human approval must reference the current head. Craft only observes a later GitHub merge/closure; it has no merge action.

Chat in concise French, all third-party content in English. Slack and production remain read-only. Do not turn a question into execution. Source Conductor/Ship repositories and Mac originals remain untouched.
