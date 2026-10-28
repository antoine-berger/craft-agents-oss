# Branch stacks

A new session started with a copied branch or pull request records its exact branch base and starting commit. Its checkout remains independent. Craft links the parent chat only when one ordinary session in the same workspace is verified on that branch in the same Git repository. Duplicate matches remain ambiguous; hidden helpers are not treated as parent chats.

An explicit branch copy uses that local branch's current commit when it exists, rather than silently substituting an older origin-tracking reference. A missing local branch retains the existing remote-reference resolution. The default-branch policy and PR-start behavior are unchanged.

Open **Worktree tools → Stack** to see the parent, dependent sessions and the local branch state. **Refresh** reads local Git references and existing PR-cache evidence. It does not fetch, rebase, push or send prompts to any chat. Archived parents remain archived.

- **Up to date:** the child contains the current local parent branch.
- **Needs restack:** the parent advanced and the child does not yet contain those commits.
- **Parent history changed:** the parent was rewritten and the child still needs its base reviewed.
- **Parent unavailable / changed branch:** the recorded chat or checkout no longer provides the verified original base.
- **Parent ambiguous / Unknown:** available evidence does not identify a safe parent. No relationship is guessed.

An owner-performed rebase or restack is reflected on the next refresh. A merged parent PR is labelled only when existing cached evidence identifies that same parent branch; this does not prove that the local default branch has been updated. Historical sessions without recorded allocation metadata are not assigned invented stack relationships.
