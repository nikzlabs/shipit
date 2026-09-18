---
issue: planning#499
title: Agent merge, granted per repository
description: A per-repository permission that lets an agent merge the pull request its own session opened, stored by ShipIt and never readable from the repository.
---

# Agent merge, granted per repository

Today an agent can merge only in a **sandbox** session, and only when the user
granted `dangerousGitHubOps` at creation
(`docs/224-sandbox-merge-capability`). In an ordinary repo-bound session the
merge is refused with a 403, so the agent can take a pull request to green CI
but cannot land it. This feature moves the permission to the **repository**.

## Requirements

1. A user can allow agents to merge pull requests in a given repository, and can
   withdraw that permission again at any time.
2. The permission is off for every repository until the user turns it on.
3. ShipIt stores the permission, and only ShipIt's own interface can set it. No
   file inside the repository grants it, so an agent cannot give itself the
   permission by writing to the repository.
4. When the permission is on, an agent in a repo-bound session can merge the
   pull request that its own session opened. A pull request opened **before this
   feature shipped** is excluded: ShipIt has no record that it opened it. Such a
   session merges from the pull-request card as it does today, and works normally
   again as soon as it opens its next pull request.
5. An agent cannot merge any other pull request. This includes a pull request
   opened by a different session, by another agent, or by a person.
6. When the permission is off, an agent that tries to merge gets a refusal that
   says the permission is off for this repository and where the user turns it
   on.
7. These guardrails apply to every agent merge, with the permission on: **every
   check GitHub reports** for the commit must pass, a draft pull request is
   refused, an administrator override is refused, and GitHub's own refusal is
   shown word for word.
8. A merge that GitHub's review rules block is refused, and the refusal says
   that a review is missing or that changes were requested.
9. Each agent merge is recorded in the chat transcript. The record names the
   pull request, says the agent merged it, and is still there after a page
   reload. If ShipIt cannot prove that it performed the merge — a crash between
   the merge and the record — the record says instead that the agent asked for
   that commit to be merged and that it is now merged.
10. After the agent merges its own pull request, the session can open the next
    pull request without help from the user.
11. After an agent merge, the pull request card and the session state are the
    same as after a merge from the card's own merge button.
12. The permission for sandbox sessions does not change. A sandbox session has
    no repository record, so it keeps its own per-session grant.
13. Ops sessions cannot merge. Their behaviour does not change.
14. A merge includes the work that the agent did in the same turn. The merge
    command commits the pending changes and pushes them before it merges.
15. If ShipIt cannot commit the pending changes, the merge does not happen. The
    agent is told why, and the pull request stays open.
16. The checks in req 7 apply to the code that the merge lands. If the push in
    req 14 adds new commits, the checks for those new commits decide the merge.
17. When the checks for those new commits are not complete, the merge command
    refuses. The refusal says that the push started the checks again, and that
    the agent can merge once they pass. The command does not wait by itself.

**"Merge it when the checks pass" is a separate feature**, in
`docs/288-agent-merge-arming`, which has since shipped: a repo-bound `--auto`
records a request there. Sandbox `--auto` is unchanged (req 12).

## Open questions

None.

## Resolved questions

- 2026-09-02 — Should the grant let the agent merge directly, or only arm
  auto-merge so that ShipIt merges when CI turns green? **Answer: direct merge,
  with the guardrails.** The agent decides both readiness and timing; the
  guardrails in req 7 and req 8 are what hold. (req 4, 7, 8)
- 2026-09-02 — How wide is the grant? **Answer: the pull request of the agent's
  own session only.** This removes the dead end but gives no agent power over
  another agent's or a person's pull request, and it removes the case where
  text in a different pull request talks the agent into merging it. (req 4, 5)
- 2026-09-02 — Where does the switch live: ShipIt's repository settings, or
  `shipit.yaml` in the repository? **Answer: ShipIt's repository settings.** An
  agent can write `shipit.yaml`, so a permission declared there is a permission
  the agent can grant itself. This keeps the rule from
  `docs/224-sandbox-merge-capability`: a capability is set server-side and is
  never inferred from workspace files. (req 3)
- 2026-09-02 — The agent works in the turn, and ShipIt commits only after the
  turn ends. Must the merge command commit and push first? **Answer: yes.**
  Without it the merge lands the state from before the turn, and the agent
  believes its work shipped. `agentCreatePr()` already flushes this way through
  `flushPendingTurnCommit()`; the merge must do the same. (req 14, 15, 16)
- 2026-09-02 — The push in req 14 starts the checks again, so a direct merge is
  refused nearly every time. Must the command then wait for green by itself?
  **Answer: no. It refuses and says so.** The agent then merges when the checks
  pass. A command that waits would report success while nothing merged, and it
  would turn every merge into the auto-merge behaviour that was already
  rejected. (req 17)
- 2026-09-03 — Requirement 7 said "required checks must pass", but a live read
  returns GitHub's combined status for the commit and cannot say which checks are
  required; the per-check flag needs paging every check run, and the
  branch-protection API needs a permission ShipIt's tokens deliberately omit.
  **Answer: every reported check must pass.** Stricter than the original wording
  — a failing optional check stops an agent merge, though the user can still
  merge from the pull-request card — and fail-closed from one field. (req 7)
- 2026-09-03 — Requirement 9 said the record "says the agent merged it", but a
  crash between GitHub accepting the merge and the record being written leaves
  ShipIt able to prove only that the agent authorised that exact commit and that
  the commit is now merged; a user, the card or GitHub's own auto-merge could
  have landed it. **Answer: say what is provable.** A witnessed merge keeps the
  full claim; a recovered record uses the narrower wording. (req 9)
- 2026-09-03 — A session whose pull request predates this feature has no proof
  that ShipIt opened it, and a branch lookup cannot tell it from a person's.
  **Answer: exclude those pull requests.** The gap is self-healing — the session
  works normally again as soon as it opens its next one — and no heuristic gets
  near the failure requirement 5 exists to prevent. (req 4)
- 2026-09-03 — Three unprimed reviews in a row returned blockers, every one of
  them inside the "merge when the checks pass" arming, while the direct-merge
  half had been stable for many rounds. **Answer: ship the direct merge first.**
  Requirements 18–21 moved to `docs/288-agent-merge-arming` with their own plan
  and pull request. (req 17, and the removal of 18–21)
