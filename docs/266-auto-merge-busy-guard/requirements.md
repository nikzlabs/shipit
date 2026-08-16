---
title: Auto-merge must not merge while a session is working — requirements
description: What the operator asked for after PR #2327 merged mid-turn, in their words.
---

# 266 — Auto-merge while the agent is working: requirements

Source: the incident packet for PR #2327 (`nikzlabs/shipit`, session
`5203c910-…`, 2026-08-16), written by the ops session that diagnosed it, plus
one clarification in chat. These are the operator's statements, numbered.
`plan.md` implements them and cites them as `(req N)`.

## What happened

Auto-merge merged PR #2327 while the agent was mid-turn applying reviewer
feedback. Auto-commit fires after a turn ends, so those edits were still in the
working tree: they were never pushed, CI never saw them, and the merged PR is
missing the review fixes. `merged-push-guard` then correctly refused to push the
commit that landed 4m45s later, so no work was lost — but the session was left
stranded on a branch with no open PR.

## Requirements

1. Auto-merge must not merge a pull request while its session's agent is still
   working.
2. "Still working" includes the whole window in which the agent can still
   produce commits — not only a running turn, but the post-turn commit, the
   debounced auto-push it arms, and time spent waiting on a backgrounded review
   consult.
3. Being busy is a normal, transient wait. It must not surface as an error, and
   the merge must happen on its own once the session is quiet — no user action.
4. A pull request whose session has a live runner is not handed to GitHub native
   auto-merge; ShipIt's own managed loop owns it, because that is where the wait
   in req 1 is enforceable. Native arming stays available for sessions with no
   live runner, so the "merges even when ShipIt is not watching" property is kept
   where it still holds.
5. A pull request that is armed, green, and whose session is gone must still
   merge.
6. A merge held back by req 1 must not be presented to the user as a repository
   misconfiguration. Today `managed` means "GitHub native was unavailable" and
   carries the settings link and error tooltip; the new state needs its own,
   honest wording ("will merge when this session finishes").
7. When auto-merge merges a pull request, ShipIt records which session, which PR
   number, and whether the merge was native or managed; it also records when it
   holds a merge because the session is busy. The ops investigation could not
   tell who merged #2327 because neither path logged anything.
8. The fix covers the merge-while-busy hole only. The second finding from the
   same incident — a PR that merges over a dirty tree produces no transcript
   notice — is being handled in its own session.
9. `merged-push-guard` is not weakened. It behaved correctly and is the reason
   no work was lost.

## Resolved questions

- **2026-08-16 — Does the guard cover an agent that is waiting on a review
  rather than running a turn?** Operator, in chat: "also if the agent is waiting
  for review etc." Yes — folded into req 2. A backgrounded `shipit agent run`
  consult is exactly what the incident's own turn was doing for 8 of its
  minutes, and it holds `subAgentSpawnsInFlight`, one of the terms in the
  runner's `agentBusy`.

- **2026-08-16 — Arm late / disarm on turn start, or prefer the managed loop?**
  Operator, in the packet: prefer the ShipIt-managed loop while a session is
  live (req 4). Arm-late was rejected for per-turn GraphQL churn plus a new
  silent-never-merges failure mode if a re-arm failed.

## Open questions

None.
