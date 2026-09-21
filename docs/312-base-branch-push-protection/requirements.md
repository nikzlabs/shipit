---
issue: planning#605
title: Base-branch push protection
description: No ShipIt path may publish a ref the session does not own, and no force-push may move a remote branch strictly backwards.
---

# Base-branch push protection

On 2026-09-21 the base branch of an unrelated user repository (`nicolasalt/reward-tag`)
silently rewound, dropping three already-merged pull requests while GitHub kept
reporting all three as merged. Branch protection is the obvious guard and needs
a paid GitHub plan that user does not have, so the guarantee has to come from
ShipIt.

1. ShipIt never publishes a branch that is not the session's own — not the
   repository's default branch, not a pull request's base branch.
2. A force-push that would move a remote branch strictly backwards — discarding
   commits the remote has and replacing them with nothing — is refused, whatever
   resolved the push target.
3. A refusal is reported. The failure this protects against is silent, so a
   push ShipIt declines must say so rather than log nothing.
4. A deliberate rewrite of the session's own branch keeps working: rebase
   republication, reset-onto-base healing, the release-branch flow, and the
   re-arm past a merged pull request are all unaffected.
5. The agent cannot reach the same outcome by hand from a normal turn: the
   commands that move a session's checkout onto a shared branch, and the
   commands that force-push, are judged the same way whichever spelling is used.

## Open questions

None outstanding.

## Resolved questions

- 2026-09-21 — Should ShipIt fail closed when it cannot read the remote tip it
  is about to overwrite? Yes, for a **force**-push only. The loss it guards
  against is unrecoverable and unreported, while a refused force-push is
  visible and retryable. Ordinary (fast-forward) pushes are untouched: git
  already refuses those when they would discard anything.
- 2026-09-21 — Should the guard live at the call sites or in the push
  primitive? Both. The call sites express *intent* (this branch is not ours to
  publish) and the primitive is the backstop that does not depend on any caller
  having asked the right question — the incident's own call site is not certain,
  so a fix resting on identifying it would be a guess.
