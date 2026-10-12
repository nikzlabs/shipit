# 196 — Notify-on-merge: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

This document starts with the rework of 2026-10-10. The behaviour that shipped before it has
no recorded requirements, and `plan.md` describes it. Requirement 1 states the one part of
that behaviour which the rework builds on.

1. A parent session that arms a watch on a child is told one time for that arm: when the
   child's pull request merges, or when it closes without a merge. The notice goes to the
   parent's inbox, and it does not start a turn of its own in the parent
   (docs/328-session-message-inbox req 6).

2. A parent can follow one child across several pull requests. Each time the parent arms
   the watch again, it is told at the child's next pull request that merges or closes.

3. An arm that the parent makes before it has read the notice about the child's previous
   pull request is not lost. This includes an arm made in the turn in which the parent
   reads that notice. It applies to the child's next pull request.

4. An arm that the parent makes after it was told about a pull request does not tell it
   again about that same pull request.

## Resolved questions

- 2026-10-10 — Requirements 2 to 4. PR #3136 measured two faults and recorded them in
  `plan.md` as known limits: an arm made during the wake for the previous merge did nothing,
  and an arm made after the wake fired again for the pull request already reported. The
  follow-up offered to the user was "a parent's watch cannot follow a child across several
  PRs"; the user's answer was "fix both after this pr is merged" (the second item is the arm
  card of `docs/239-self-merge-wake`).
- 2026-10-10 — Does one arm stay active for all later pull requests of the child, or does the
  parent arm again for each one? The agent stated "arm again for each one" in chat as the
  rule it would build, and asked the user to say so before the merge of PR #3136 if they
  wanted the other rule. The user merged PR #3136 and did not change the rule. This is
  recorded as an accepted default, not as an explicit choice. Requirement 1 keeps the
  one-wake-per-arm rule for that reason.
- 2026-10-11 — Do the notices about a child's pull request go to the parent's inbox? The
  user: "Yes, include them" (recorded as docs/328-session-message-inbox req 6). So
  requirements 1 to 4 say "told" where they said "woken", and requirement 1 names the inbox.
  Requirement 3 said "while the wake for the child's previous pull request is still in
  delivery", and included "an arm made inside that wake turn". A notice in the inbox has no
  delivery that takes time, so the requirement now names the time before the parent reads
  the notice. Its purpose did not change: an arm is not lost, and it is for the next pull
  request.
