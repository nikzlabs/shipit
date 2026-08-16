---
issue: planning#396
title: Merge-time reset notice — design
description: Write the refused-reset explanation into the transcript at merge detection, once per refusal episode.
---

# 266 — Merge-time reset notice: design

Implements [`requirements.md`](./requirements.md). Requirements are cited as `(req N)`.

## The gap

`onMergeDetectedCb` (`app-lifecycle.ts`) called `emitResetEligibleSignal`
(`services/pre-turn-reset.ts`). For a MERGED session that computed the docs/218 safety gate,
wrote ONE server console line, and emitted the transient `reset_eligible` WS message that shows
or hides the composer's "start from the latest base" control.

When the gate refused, none of that reached the user. The control did not appear, and nothing
distinguishes a control that is hidden from one that never existed. planning#297's persisted
refusal notice is built inside `autoResetMergedBranchOnContinue` — the PRE-TURN path — so it
waits for the next message.

The incident (session 5203c910, PR #2327, 2026-08-16):

```
10:38:02  [pr-poller] Post-merge: marked 5203c910-… as merged
10:38:02  [pre-turn-reset] reset_eligible=false … (merge-detected): dirty-tree — … uncommitted
          paths: …/PreviewToolbar.tsx, …/usePreviewToolbarCollapse.ts
10:42:46  [merged-push-guard] auto-push refused … PR #2327 already merged and this commit
          (f561150) is stacked on the merged tip.
```

The agent was mid-turn applying reviewer feedback when the PR merged; its edits were
uncommitted, which is exactly why the reset was refused. The first thing the user could read
arrived 4m45s later, by which point the commit was stranded on a branch with no open pull
request. Those 4m45s were the window in which the fix was still cheap: commit, then
`gh pr create`.

The refusal detail was never the problem — `computeResetBlocker` returns the clause and the
detail, planning#341 made the `dirty-tree` detail name the offending paths, and `ResetSkipInfo`
already carries a ready-to-emit notice and level. **The wiring was missing, not the words.**

## The change

`announceResetStateOnMerge` (`services/pre-turn-reset.ts`) replaces `emitResetEligibleSignal`.
It does what that did — recompute eligibility, log the one ops line, push the transient signal —
and then, when the session is merged and the gate refused, writes the refusal into the
transcript (req 1).

`emitResetEligible` now returns the whole `ResetEligibility` record instead of a boolean nobody
read. The blocker the notice describes is therefore the same evaluation the emitted signal came
from: one git pass, and the signal and the notice cannot disagree about which clause refused.

### Which refusals are said

Every clause `computeResetBlocker` can return on a merged session — its whole union minus
`not-merged`, which is gated out because it is the ordinary state of nearly every session rather
than a failure (req 2). No sub-selection: each remaining clause means "your branch was left on
already-merged commits and ShipIt will not move it", which is the actionable fact whichever one
it was, and a hand-picked subset would be a second list to drift from the gate.

The two `info`-level clauses — the global setting being off, and the per-send untick — cannot
occur here at all. This is the safety-only gate; both of those are consent, evaluated on the
pre-turn path only.

### Merge-time wording, not turn-time

`buildMergeTimeSkipNotice` is a second string rather than a shared one (req 3). The pre-turn
notice's "this branch was not reset **for this turn** … send another message" reads as nonsense
at a moment the user did not initiate. The merge-time one leads with the merge, states that
nothing was discarded, then the cost (no open pull request, so nothing committed here will be
auto-pushed), then the way out — and it names committing the work first, because `dirty-tree` is
the clause this fires for in practice and discarding is not what the user wants there.

### Where it is written, with or without a runner

The transcript, because that is the durable surface and `reset_eligible` is not (req 5). So the
call site resolves the session dir from the live runner **or** `sessionManager`'s
`workspaceDir`, and the notice is persisted either way:

- **live runner** → `emitNoticeInTurn`, which routes through `emitChatCard` and so picks the
  correct persistence path for a turn that is running — the incident's own case, where appending
  a row would have floated the notice above the running turn's rebuilt rows;
- **no runner** → `persistNoticeUnattached` (new, `chat-card-persistence.ts`): persist with no
  live transport. A named function rather than `emitNoticePostTurn` with a no-op `emit`, so "no
  transport exists here" can never be misread as a forgotten broadcast.

`chatHistory` is a REQUIRED key with a possibly-undefined value, because the PR poller's wiring
makes the manager optional and an optional persist dep is exactly how a transcript card ships
emit-only. A missing one logs `notice … was DROPPED` and — importantly — does **not** claim the
episode, so the pre-turn notice still fires.

### No double-notify: one paragraph per refusal EPISODE

`notifiedSkipClause: Map<sessionId, string>` — the shape `auto-push-scheduler.ts` already uses
for diverged pushes ("nine identical notices is noise that trains the reader to skip the
tenth"), with the same two stated imprecisions: not pruned on teardown, and not surviving an
orchestrator restart (so a still-standing refusal is said once more after one — the safe
direction).

The key is **the merge it is about, plus the clause that refused** (`episodeKey`: `mergedHeadSha`
— or the `previousMergedPr` breadcrumb — and the clause). Two things fall out of that:

- The episode ends the moment the refusal becomes a **different** one. A dirty tree the user
  commits away, followed by `head-moved` for those new commits, is a new fact and is said again.
- A **later merge** can never inherit an earlier one's entry. Keying on the clause alone made
  the entry outlive the merge it described, and the paths that resolve a refusal — both reset
  modes, both re-arms, any interval in which the gate simply became eligible — are too many for
  "we cleared it everywhere" to be a checkable claim. A stale entry there is not noise but
  SILENCE: a second pull request merging onto the same dirty tree would match and say nothing,
  which is this feature's own defect. The anchor removes the class instead of chasing it.

`clearResetSkipEpisode` still fires wherever a refusal is resolved — both reset modes, a branch
already at the base tip, a session the re-arm un-merged, an eligible gate at merge detection —
but as the fast path, not the guarantee.

**A claim is given back when the delivery fails.** The merge-time path releases on a throw from
its own write; `pre-turn-reset-hook.ts` releases on a failed LATE write (the anchored one still
has that fallback to retry on, so releasing there would let both attempts write). Otherwise a
storage blip would silence every later turn under the same refusal. The converse — the notice
was emitted, the persist threw, and the recorded card is flushed later anyway — can duplicate
it, which is the right side of the trade: the failure this feature exists to end is silence.

`skipped()` therefore drops **the notice and only the notice** when the clause was already
claimed (req 4). The console line and the agent prompt prefix always fire: the agent is a fresh
reader on every turn, and the ops line is what an investigation greps. `ResetSkipInfo.notice` is
now optional, and `pre-turn-reset-hook.ts` guards on it.

Two deliberate consequences:

- The rule is **uniform across both emitters**, so a second turn under an unchanged refusal is
  also silent, not only the turn right after the merge. Repeating an identical paragraph per
  turn was the noise the episode model exists to remove, and the agent prefix still tells the
  agent on every turn.
- The two `info` clauses are **exempt and do not touch the episode**. They are not a standing
  condition being re-reported; they are a fact about *this* message ("you unticked it for this
  send"), so every send earns its own record. Claiming for them would also overwrite a standing
  safety episode and let the real refusal be said twice.

### What did not change

The gate itself (req 6). Refusing a hard reset over a dirty tree stays exactly as it was; only
the moment the refusal is said moved. Nothing in `auto-merge-manager.ts`, `services/github.ts`
arming, or the merge routes is touched — the related finding from the same incident (auto-merge
merging a PR while the agent is still busy) is a separate fix.

Fail-safe end to end (req 7): the eligibility computation swallows its own git errors, and the
whole of `announceResetStateOnMerge` is wrapped so nothing in it reaches the caller. That outer
guard is not belt-and-braces — `emitMessage` is an EventEmitter broadcast, so one broken viewer
listener rejects the eligibility signal, and `onMergeDetectedCb` does more work after this call
(the docs/145 bare-cache refresh) that is not this feature's to lose.

### One stated race

`markMergedAndPruneExcess` sets `mergedAt` and then awaits remote-branch cleanup before this
call runs. A turn starting inside that window takes the pre-turn path, refuses on the same
clause, claims the episode, and makes the merge-time notice a no-op. The user is still told
exactly once — with the turn-time wording, which is accurate there, because a turn genuinely
exists. Left as is: closing it would mean ordering the announcement ahead of merge bookkeeping
for a window in which the requirement is already met.

## Key files

- `src/server/orchestrator/services/pre-turn-reset.ts` — `announceResetStateOnMerge`,
  `buildMergeTimeSkipNotice`, the episode map + `clearResetSkipEpisode` / `claimSkipNotice`,
  `emitResetEligible`'s widened return.
- `src/server/orchestrator/app-lifecycle.ts` — `onMergeDetectedCb` call site; resolves the
  session dir without a runner.
- `src/server/orchestrator/chat-card-persistence.ts` — `persistNoticeUnattached`.
- `src/server/orchestrator/pre-turn-reset-hook.ts` — guards the now-optional skip notice.
- Tests: `services/pre-turn-reset.test.ts` (merge-time notice, clause set, no-double-notify),
  `pre-turn-reset-hook.test.ts` (the suppressed repeat still carries the agent prefix).
