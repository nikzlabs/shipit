---
issue: planning#522
title: Compact the context when a merged session continues
description: A second composer checkbox, beside "Start from the latest base", that compacts the agent's context before the next turn of a session whose PR already merged.
---

# 295 — Compact the context when a merged session continues

Extends [docs/218 — Auto-update a merged session's branch to latest base](../218-auto-reset-merged-branch-on-continue/plan.md),
which put the "Start from the latest base" control in the composer, and uses the
compaction primitive built in [docs/178 — Context Compaction](../178-context-compaction/plan.md)
and extended to all four harnesses in [docs/276 — Headless compaction triggers](../276-headless-compaction-triggers/plan.md).

## Problem

A merged session's branch is reset to the latest base, so the working tree holds
current code. The agent's context is not reset. It still holds the full
conversation about work that is now shipped, and that conversation describes a
tree that no longer exists in that form. The user pays for those tokens on every
later turn, and the agent reads them as live work in progress.

## Requirements

1. When ShipIt offers the "Start from the latest base" control in the composer,
   it also offers a second control that compacts the agent's context.

2. The second control is ticked by default.

3. The second control is offered every time the first one is offered. Its
   visibility does not depend on how full the context is, in tokens or as a
   percentage of the window.

4. When the control is ticked and the user sends the message, the agent's
   context is compacted before the turn runs.

5. The user can untick the control. The untick applies to that one message. The
   next merged session that continues shows the control ticked again. This
   matches the sibling control in docs/218.

6. The two controls are independent. Each one governs only its own action, and
   the state of one does not change what the other does.

7. After the compaction, the agent still knows that its previous pull request
   merged and that it must not re-apply the shipped work. The guarantee that
   docs/218 gives today does not become weaker.

8. The user can see that a compaction is running, and can see afterwards that it
   ran, in the chat transcript. This is the same visibility that a `/compact`
   command gives today (docs/178).

9. If the compaction fails, the user's message still runs. The turn is never
   lost because the compaction did not complete.

10. Where the session's agent backend cannot compact its context, the control is
    not offered.

## Open questions

- **Which global setting governs this?** The sibling behaviour has a global
  toggle, `autoResetMergedBranch`, in Settings → Advanced. Options: (a) the
  compaction shares that toggle, so one switch governs "start the next slice
  clean"; (b) the compaction gets its own toggle beside it; (c) there is no
  global toggle and the per-send checkbox is the only control. Recommendation:
  (a) — a rarely-changed switch does not need its own row, and the two actions
  are one intent.

## Resolved questions

- **2026-09-07 — Should the control appear only when the context is large enough
  to be worth the cost of compacting?** No. A percentage threshold is
  model-dependent: on a 1M-token window even a low percentage is a very large
  absolute context, which costs more per turn and gives worse results, so a
  percentage gate becomes strictest exactly where the cost is highest. Compaction
  between pull requests is always a win. This is why requirement 3 forbids any
  occupancy or context-size threshold.
