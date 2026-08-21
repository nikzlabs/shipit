---
issue: planning#396
title: Merge-time reset notice — requirements
description: When a PR merges onto a branch ShipIt will not reset, say so at that moment, not at the user's next message.
---

# 266 — Merge-time reset notice: requirements

**These are the things this feature changes. Everything ShipIt already does is a requirement
too, and is not restated here** — existing behaviour must keep working at least as well as it
does today.

The setting: when a session's pull request merges, ShipIt evaluates the docs/218 safety gate to
decide whether the branch may be reset to the latest base. When the gate refuses, the user was
told nothing at the time — the "start from the latest base" composer control simply did not
appear, and a hidden control is indistinguishable from one that was never there. planning#297's
refusal notice is built on the pre-turn path, so it did not reach the user until their next
message, which may be much later or never.

1. When a session's pull request merges and the safety gate refuses to reset the branch, the
   user is told **at merge detection**, in a message they can read — not at their next turn.
2. The notice says which clause refused, using the refusal detail the gate already produces
   (including, for a dirty tree, the uncommitted paths planning#341 added).
3. The notice's wording works at a moment the user did not initiate and may not be present for:
   it reads as "your pull request just merged, here is why the branch was left where it is, and
   what to do", not as "your branch was not reset for this turn".
4. A user who reads the merge-time notice and then sends a message does not read the same
   paragraph again.
5. The notice is durable: the user finds it when they come back, including when no runner was
   live at merge time.
6. What the safety gate DECIDES is unchanged. Refusing a hard reset over a dirty tree is
   correct and stays; this is only about when the refusal is said.
7. A failure in any of the above never breaks post-merge bookkeeping or a running turn.

## Resolved questions

**2026-08-16 — which refusals earn a merge-time notice?** The incident packet named `dirty-tree`
as clearly deserving one, rated `setting-off` / `opted-out` as the user's own choice, and asked
for the chosen set to be justified. Resolved as: **every clause the safety-only gate can return
on a merged session** (its whole union minus `not-merged`). Each of them means the same
actionable thing — the branch was left on already-merged commits and ShipIt will not move it —
and a hand-picked subset would be a second list to drift from the gate. The two consent clauses
cannot occur at merge time at all: they are evaluated only on the pre-turn path. See
`plan.md` → "Which refusals are said".

**2026-08-16 — persist the notice when no runner is live?** The packet's own reading ("it
probably should — the transcript is durable and the reset-eligible signal is not") is adopted as
requirement 5. The merge happened whether or not anyone was watching.
