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
   lost because the compaction did not complete. The transcript says that the
   compaction did not succeed, so a failure is never silent.

10. Where the session's agent backend cannot compact its context, the control is
    not offered.

11. One setting in Settings → Advanced governs both this compaction and the
    branch reset of docs/218. When that setting is off, neither control is
    offered. No second setting is added, and the setting says in its own
    description that it governs both actions.

12. A `/compact` command that the user sends is still one compaction, and
    nothing more. It does not compact twice, and it does not start the branch
    reset. This boundary already exists today, and this feature does not weaken
    it.

13. A continuation that the user did not type also compacts, under the same
    setting and in the same conditions in which its branch is reset. It has no
    checkbox, so the setting alone decides.

## Requirement provenance

Requirements 1 to 6, 11 and 13 come from what the user asked for and decided.
Requirements 7 to 10 and 12 were not asked for: each one keeps a guarantee that
already ships (docs/218 for the merge notice, docs/178 for how a compaction
appears and for the `/compact` boundary) from becoming weaker. They are recorded
apart from the user's own requirements so that the difference stays visible.

## Open questions

None.

## Resolved questions

- **2026-09-07 — Should the control appear only when the context is large enough
  to be worth the cost of compacting?** No. A percentage threshold is
  model-dependent: on a 1M-token window even a low percentage is a very large
  absolute context, which in the user's judgement costs more per turn and gives
  worse results, so a percentage gate becomes strictest exactly where the cost is
  highest. The user's decision is that compaction at the merge boundary is worth
  it whatever the occupancy. This is why requirement 3 forbids any occupancy or
  context-size threshold. (The reasoning recorded here is the decision-maker's;
  the effect of context length on model quality is not measured in this
  repository.)

- **2026-09-07 — Which global setting governs the compaction: the existing
  "Start from the latest base after a merge" toggle, a new toggle beside it, or
  none at all?** The existing toggle governs both. One switch means "start the
  next slice clean", and a rarely-changed switch does not earn a second row in
  Advanced that reads as a near-duplicate of the first. This carries a
  constraint into the design: turning that one setting off must hide both
  controls, which requirement 11 states.

- **2026-09-07 — Does a continuation that the user did not type also compact?**
  Yes, governed by the same setting. A wake turn after a merge, a
  `shipit session message`, and a click inside an agent-built page already get
  the branch reset of docs/218 under that setting, and the wake turn is where a
  stale context does the most harm, because nobody is watching the agent re-read
  work that already shipped. A narrower answer covering only the wake turn was
  offered and rejected: it would split programmatic continuations into two
  classes that docs/218 treats as one, and the two gates could then disagree.
  Recorded as requirement 13.
