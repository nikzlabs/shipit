---
issue: planning#721
title: An armed merge either merges or the agent is told why not
description: Once an agent arms `gh pr merge --auto`, ShipIt either merges it or tells the agent the request ended, and ShipIt's own rebase moves the request instead of cancelling it.
---

# An armed merge either merges or the agent is told why not

Builds on `docs/288-agent-merge-arming`. Stated by the operator after an incident:
an agent armed `gh pr merge --auto`, ShipIt's automatic conflict resolution then
rebased and force-pushed the branch, the executor cancelled the request as
"branch moved", and only the user's transcript said so. The agent never heard,
and nothing merged.

1. Once an agent has armed a merge (`gh pr merge <N> --auto`), only two outcomes
   are allowed: the pull request merges, or the agent is told the request was
   cancelled, with the reason.
2. "Told" means the reason reaches the agent's context, not only the user's
   chat. If the session is idle, ShipIt also starts a turn so the agent can act,
   as `shipit session notify-on-merge --self` starts a turn when a merge lands.
   Every path that ends a request without a merge does this, including the user
   withdrawing the repository's merge permission.
3. When ShipIt itself rebases and force-pushes a branch that has a pending
   request (automatic conflict resolution, a clean automatic rebase, a Sync the
   user starts), the request moves to the new commit instead of being
   cancelled. A push ShipIt did not make still cancels it. ShipIt still merges
   only a commit whose checks passed: the checks must pass on the new commit.
4. The user's transcript notice for a cancelled request stays as it is.
5. The agent is told once: the notice is not delivered twice, and a branch-sync
   notice does not overwrite it.
6. When a request is pending, the conflict-resolution prompt says that a merge
   of the pull request is armed, and that ShipIt moves it to the rebased commit.

This refines `docs/288-agent-merge-arming` req 3: "the branch moves" there now
means a move ShipIt did not make itself.

## Open questions

None.

## Resolved questions

None. Requirements 1–5 are the operator's words from the incident packet;
requirement 6 is the packet's optional item C.
