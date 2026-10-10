# 196 — Notify-on-merge: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

This document starts with the rework of 2026-10-10. The behaviour that shipped before it has
no recorded requirements, and `plan.md` describes it. Requirement 1 states the one part of
that behaviour which the rework builds on.

1. A parent session that arms a watch on a child is woken one time for that arm: when the
   child's pull request merges, or when it closes without a merge.

2. A parent can follow one child across several pull requests. Each time the parent arms
   the watch again, it is woken at the child's next pull request that merges or closes.

3. An arm that the parent makes while the wake for the child's previous pull request is still
   in delivery is not lost. This includes an arm made inside that wake turn. It applies to
   the child's next pull request.

4. An arm that the parent makes after it was told about a pull request does not wake it again
   for that same pull request.

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
