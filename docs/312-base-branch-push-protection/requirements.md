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

1. ShipIt never FORCE-pushes a branch that is not the session's own — not the
   repository's default branch, not a pull request's base branch.
2. A force-push that would move a remote branch strictly backwards — discarding
   commits the remote has and replacing them with nothing — is refused, whatever
   resolved the push target.
3. A refusal is reported. The failure this protects against is silent, so a
   push ShipIt declines must say so rather than log nothing.
4. A deliberate rewrite of the session's own branch keeps working: rebase
   republication, reset-onto-base healing, the release-branch flow, and the
   re-arm past a merged pull request are all unaffected.
5. A push target is a branch name, never a refspec. `+main:main` reaching an
   ordinary push is a force with no flag to find, and must be refused as one.
6. The agent cannot reach the same outcome by hand from a normal turn: the
   commands that move a session's checkout onto a shared branch, and the
   commands that force-push, are judged the same way whichever spelling is used.
7. An ORDINARY (fast-forward) push is refused on a shared branch too. A
   session's commit reaches the repository's default branch only through a pull
   request, whether the push target came from the checkout or from the caller.
8. A session cannot be STARTED on a shared branch. The one path that takes a
   branch name from its caller — forking — refuses one.
9. A repository that has never been published is not a shared branch. A new
   project can push its first branch to the empty remote it was just pointed at.

## Open questions

_None._

## Resolved questions

- 2026-09-21 — Should an ORDINARY (fast-forward) push also refuse a shared
  branch? Yes, everywhere ShipIt pushes: the auto-push, the durability push that
  precedes deleting a checkout, and the pre-merge sync. A fork may not be
  created on one either. Asked because guarding it would stop auto-push for a
  session working on the default branch. Every *repo-backed* session gets a
  branch of its own — `shipit/<slug>`, `shipit/install-…`, an issue-seeded
  `<id>-<slug>`, `<parent>-<slug>`, or `release/<version>` — and the fixtures
  that suggested otherwise build their session through `/api/_test/sessions`, a
  route registered only in test mode. A session created from a TEMPLATE is the
  exception: `GitManager.init()` starts it on a local `main` and records no
  branch, so requirement 9 carves out the case that matters — an origin with no
  branch of that name is not a shared branch.

- 2026-09-21 — Should ShipIt fail closed when it cannot read the remote tip it
  is about to overwrite? Yes, for a **force**-push only. The loss it guards
  against is unrecoverable and unreported, while a refused force-push is
  visible and retryable. Ordinary (fast-forward) pushes are untouched: git
  already refuses those when they would discard anything.
- 2026-09-21 — Does a deliberate rewrite ever move a branch strictly backwards?
  Yes, in one place: `reset-to-base` drops the commits above the base, and with
  `--force` that is an authorised rewind of the session's own branch. So the
  refusal is unconditional at the primitive and the reset paths opt in
  explicitly, after verifying the target is theirs.
- 2026-09-21 — Should the guard live at the call sites or in the push
  primitive? Both. The call sites express *intent* (this branch is not ours to
  publish) and the primitive is the backstop that does not depend on any caller
  having asked the right question — the incident's own call site is not certain,
  so a fix resting on identifying it would be a guess.
