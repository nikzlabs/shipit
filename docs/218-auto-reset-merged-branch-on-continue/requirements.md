---
issue: planning#522
title: Auto-update a merged session's branch to the latest base
description: What the post-merge continuation must do, in observable terms — including that the offer belongs to one merge and is made once.
---

# 218 — Auto-update a merged session's branch to the latest base

Written after the feature shipped, so it is **not** a complete record of its
original requirements: [plan.md](./plan.md) is still the description of what the
feature is and how it works. What is numbered here is what the user has stated
in their own words, so that a later change can be checked against it.

## Requirements

6. The offer to start from the latest base belongs to **one merge**, and the
   first message after that merge is the only one that can trigger the branch
   reset or the context compaction. Once the user has answered the offer — by
   accepting it or by unticking it — it is not made again for the same merge. A
   later merge makes a new offer. Requirement 7 states the one exception.

7. When the first message after a merge accepted the branch reset and the reset
   did not happen — the fetch failed, or something blocked it — the next message
   offers the reset again, with its control ticked, and the user can untick it.
   This goes on until the reset moves the branch or the user unticks it. The
   context compaction is not part of this exception: it is offered once for
   each merge.

## Requirement provenance

Requirement 6 comes from the user, on 2026-09-13, in their own words. The
numbering starts at 6 rather than 1 because requirements 1–5 were never written
down: the feature predates this discipline, and inventing them now from the
shipped code would record the agent's reading as the user's intent. Append here
as the user states more; do not backfill from `plan.md`.

Requirement 7 comes from the user, on 2026-10-12, as the answer to a question
that an independent review raised against requirement 6.

## Open questions

None.

## Resolved questions

- **2026-10-12 — The first message after a merge accepted the reset, and the
  reset did not happen (the fetch failed, or a blocker appeared). What must the
  next message do?** Offer it again: the next message shows "Start from the
  latest base" again, ticked, and tries the reset, and the user can untick it.
  The other option was to end the offer and leave `shipit branch reset-to-base`
  as the only way, which is what the words of requirement 6 say; an independent
  review had read the shipped behavior as against requirement 6. The user chose
  to offer it again. The compaction does not repeat in either case. Recorded as
  requirement 7.

- **2026-09-13 — After the user unticks "Start from the latest base", does the
  next message offer it again?** No. `plan.md` had stated the opposite as a
  deliberate design ("Sent unticked → … eligibility holds → the control
  reappears (checked) on the next message"), and it is what shipped: eligibility
  is a pure state predicate — merged, clean tree, `HEAD === mergedHeadSha` — and
  a declined continuation leaves all three true, so the branch was reset and the
  context compacted on the *following* message instead. The user's decision is
  that only the first message after the merge can trigger either action. Recorded
  as requirement 6.

  Two things this does **not** change. A reset ShipIt *refused* (a dirty tree, a
  branch that moved) was never offered — such a session is not eligible, so no
  control is shown — and it stays re-evaluated every turn, as the merge-time
  notice promises. And `shipit branch reset-to-base` still moves the branch on
  request: declining the automatic offer is not a safety gate, so it does not
  gate the explicit command.
