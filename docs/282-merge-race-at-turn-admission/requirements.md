---
title: Merge race at turn admission
description: A turn admitted inside the merge-detection poll window must not run on the merged branch.
---

# Merge race at turn admission

Written from the ops incident packet for session `15ff6abd-dfd4-40e5-813b-fc16b4532dbc`
(PR #101 of `nicolasalt/reward-tag`, 2026-08-22), which is the human input this
feature has. The packet's constraints are requirements 2–4; its problem statement
is requirement 1.

1. A turn admitted after its session's pull request merged, but before ShipIt has
   observed that merge, must not run on the merged branch. The branch is brought
   to the latest base first — the same outcome a turn one poll interval later
   already gets.
2. The merged-push guard's decision is unchanged. It behaved correctly in the
   incident and is the reason no work was lost (docs/266-auto-merge-busy-guard
   req 9 still holds).
3. The post-turn commit keeps happening on every path. Only the silent debounced
   push is ever refused; work is never lost.
4. The fix is not an extension of the docs/266 merge-while-busy gate. The session
   was idle when the merge landed — commit and push had both settled and the tree
   was clean — so a busy-gate change would address a different hole.
5. The freshness check costs no GitHub round-trip on a turn where a fresher merge
   state could not change what happens.
6. Any failure of the freshness check — a refusal, an API error, a slow
   response — leaves the session exactly as it is today and the turn runs.

## Open questions

None.

## Resolved questions

- 2026-08-23 — *Which of the three directions in the ops packet (re-check at turn
  admission / reset when a merge lands mid-turn / make the stranded state
  recoverable)?* Answered by the packet itself: it lists the directions, calls
  option 2 "cheapest but the in-flight-turn interaction needs care", and leaves
  the weighing to the implementer. Option 1 was chosen, and option 2 rejected on
  requirement 4's neighbouring ground: a `reset --hard` fired while an agent is
  running re-materializes files it has already read and may have begun editing,
  which trades a stranded commit for a corrupted turn. See plan.md
  "Why not reset mid-turn".
