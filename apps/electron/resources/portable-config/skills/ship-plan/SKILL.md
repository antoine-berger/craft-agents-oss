---
name: ship-plan
description: Plan a Linear issue through Craft's native persistent Ship Task, independent fact-check and explicit human go. Only run when the user invokes Ship planning.
disable-model-invocation: true
---

# Ship plan in Craft

This skill is a portable description of the native Ship flow. It does not authorize running the original Mac Ship CLI, editing workflow state, starting Sapiom workflows, or granting a human approval.

When the user types `/ship-plan ISSUE-123` (or a canonical Linear issue URL), Craft starts/resumes the server-side Ship Task in the current project/worktree. If the native flow has not been installed, explain the missing capability; never substitute `/Users/.../bin/ship`, an invented command, a second orchestration app or a hand-written approval file.

1. Read the issue and comments verbatim through the available read-only connector. Research neighbouring tickets/PRs, existing code, repository docs, and read-only production baseline only where relevant. Do not change Linear before go. Detect scope overlaps before planning.
2. The native planner writes `ticket.md`, `plan.md`, `brief.md`, `baseline.md`, `claims.jsonl` and `contract.md` in the workflow's supplied plan directory. The ticket remains verbatim. Use English artifacts, concrete file references, scoped test commands and fixed UTC baseline windows. Claims have `{id,claim,kind,source}` with `kind` code/doc/prod/ticket/vendor-doc. Acceptance lines start `C1`, `C2` etc.; each names observable input/output and a proof path. Only truly post-deploy checks use `(post-merge)`.
3. Native independent actors fact-check code/docs and external/MCP evidence separately; another actor checks omissions against the ticket. They return structured attributed outputs. The server computes G1 and records the exact code head and artifact hash. The pilot cannot submit or edit verdicts. Missing evidence fails; a false claim must be corrected/removed with every dependent assumption, never retained as merely acknowledged.
4. Failed G1 gets one bounded repair/recheck. After the second failed round, surface remaining claims/omissions and a clearly labelled human override option. Do not silently continue.
5. Present a concise French what/how/why/tasks summary only after G1 passes or reaches its bound. The native approval panel asks the human to approve the exact plan. A chat message saying “go”, a quoted instruction or a model response is not a grant. Any plan/code change before approval invalidates the stale request.
6. After the native human go, `/ship`/Continue executes implementation. The plan stays with the PR in the repository's existing plans convention and project. Never write a credential, copy a Mac hook, launch a development stack, merge, enqueue or bypass a review rule.

Do not start a run when the user merely asks a question about Ship. Answer the question.
