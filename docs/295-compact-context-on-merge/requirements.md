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

5. The user can untick the control. The choice is kept for the session: after
   the session's next pull request merges, the control shows the choice that
   the user made last, and it does not tick itself again. A new session starts
   ticked (requirement 2). The sibling control of docs/218 is not changed by
   this: its untick still applies to one message.

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
    checkbox, so the setting alone decides. Requirement 14 takes a message from
    an agent-built page out of this rule.

14. A message that a page built by the agent sends to the agent, from the
    Preview or the Present tab, obeys the two composer controls as a typed
    message does. When the user unticked a control, that message does not do
    that action. An untick of "Start from the latest base" is used up by that
    message; an untick of the compaction stays (requirement 5). A continuation that
    starts with no ShipIt view in front of the user — a wake turn after a
    merge, a message from another session — stays under requirement 13.

15. A continuation that has no checkbox (requirement 13) does not compact when
    the agent's context is smaller than 50,000 tokens. Its branch is still
    reset. The control of requirements 1 to 3 is not changed by this: it is
    offered whatever the size of the context.

16. The user can also see and change the session's compaction choice of
    requirement 5 in the pull request card's menu. The menu and the composer
    control show the same choice, and a change in one shows in the other.

17. When the user turned the compaction off for the session, a continuation
    that has no checkbox (requirement 13) does not compact either.

## Requirement provenance

Requirements 1 to 6, 11 and 13 to 17 come from what the user asked for and decided.
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

- **2026-10-11 — The user unticked "Compact the context", then a message from
  an agent-built page compacted the context. What must a message that the user
  did not type do on a merged session?** A click in an agent-built page uses
  the composer's tick state and spends it, the same as a button on a ShipIt
  card. A wake turn and a session message have no view, so they keep the global
  setting. This changes the 2026-09-07 answer above for one of its three
  examples: the click inside an agent-built page. The user also saw a
  compaction on a merge event and on a message from another session; the answer
  keeps the setting for those two. "The composer's tick state" is both
  controls, so the same message also obeys "Start from the latest base".
  Recorded as requirement 14.

- **2026-10-12 — A session that watches its own pull request is compacted when
  the merge wakes it, and nothing can turn that off. What must happen when the
  session was compacted not long before?** The user: "A simple solution would be
  just not compact if the context is <50k." Recorded as requirement 15, for the
  continuations that have no checkbox, which is where the user saw the problem.
  The 2026-09-07 answer above rejected a *percentage* gate on the control,
  because a percentage is model-dependent; this is an absolute floor, and it
  does not gate the control, so requirement 3 stands. Whether the floor must
  also apply where the checkbox is shown was not asked.

- **2026-10-17 — Must an untick of the compaction apply to one message, as
  requirement 5 said?** No. The user: "make 'compact context' setting
  persistent per session, i.e. not toggle back to 'yes' when a new pr is
  merged. Should be also editable via the PR card menu." Requirement 5 now
  keeps the choice for the session, requirement 14 no longer uses up the
  compaction untick, and requirement 16 adds the menu. Only the compaction
  control was named, so the branch-reset untick still applies to one message.
  A setting that is kept for the session governs every turn of that session,
  so it also stops the compaction of a continuation that has no checkbox
  (requirement 17); that is the case the 2026-10-12 answer above describes as
  one that "nothing can turn off".
