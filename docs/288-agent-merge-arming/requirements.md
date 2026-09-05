---
issue: planning#505
title: Merge it when the checks pass
description: An agent asks ShipIt to merge its pull request once the checks pass; ShipIt performs that merge itself, at the exact commit the agent asked for.
---

# Merge it when the checks pass

`docs/287-agent-merge-per-repo` lets an agent merge its own pull request when the
checks have already passed. It cannot help in the common case: the merge command
commits and pushes the turn's work first, which restarts CI, so the checks are
usually still running — and nothing wakes a session when they turn green, so the
agent cannot land the work it just produced.

This feature is the missing half. It depends on that one and does not replace any
part of it.

## Requirements

1. In a repo-bound session where the repository allows agent merging, the agent
   can ask for the merge to happen once the checks pass.
2. ShipIt performs that merge itself, and only at the commit that was current
   when the agent asked.
3. If the branch moves after the agent asked, ShipIt does not merge. It cancels
   the request and says so in the transcript.
4. When the user withdraws the repository's merge permission, every request that
   has not merged is cancelled. A merge the user armed from the pull-request card
   is not affected.
5. A request survives a restart of ShipIt, and is still carried out after one.
6. A merge ShipIt performs for a request never runs while the session's agent is
   working, and a turn does not start while such a merge is in progress. A turn
   held back for that reason starts as soon as the merge has finished.
7. Sandbox sessions are unchanged.

## Open questions

None.

## Resolved questions

- 2026-09-03 — GitHub's own merge-when-green cannot carry this: it binds to the
  pull request rather than to the commit it was granted for, so a later push by
  anyone with write access lands code the agent never authorised, and withdrawing
  the permission does not cancel it. The choice was to drop the capability, to
  build a ShipIt request bound to the exact commit, or to accept the gap.
  **Answer: build it, bound to the commit.** (req 2, 3, 4)
- 2026-09-03 — Three independent reviews in a row returned blockers, all of them
  in this mechanism, while the direct merge in `docs/287-agent-merge-per-repo` had
  been stable for many rounds. **Answer: ship the direct merge first and take
  this as its own feature**, so the risky part is reviewed on its own rather than
  as an appendix to work that is already done.
