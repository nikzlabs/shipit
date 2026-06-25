---
issue: https://linear.app/shipit-ai/issue/SHI-134
title: Re-arm a merged session for a new PR after rebase
description: When a merged branch is rebased onto its base and gains new work, drop the stale merged PR state and treat the session as ready for a fresh PR.
---

# Re-arm a merged session for a new PR after rebase

## Problem

A session branch whose PR has merged is a dead end today. Once a merge is
detected, the session is parked in a terminal state and never re-evaluated:

- The PR poller adds the session to its `mergedSessions` set and **stops polling
  it** (`pr-status-poller.ts` — the set gates the per-session/repo/supervisor
  loops).
- The PR lifecycle card is locked into the terminal `"merged"` phase
  (`PrLifecycleCard.tsx`), with no controls.
- `markMerged()` stamps `merged_at`, which sinks the session out of the sidebar
  (top-N merged cap + Done group in `filterVisibleInSidebar`) and puts it on the
  faster merged disk-eviction ladder.
- The post-turn PR flow early-returns on `session.mergedAt`
  (`services/pr-lifecycle.ts`), so even new work after the merge never produces a
  new card or a new PR.

But a real and **frequent** workflow keeps the same session alive past the
merge: merge the PR, **rebase the branch onto the now-advanced base**, keep
working, open a *new* PR for the next slice of work. GitHub allows a second PR on
the same branch name after the first merges. ShipIt does not — it keeps showing
the old merged PR and offers no path to the next one.

There is **no divergence detection** anywhere: nothing compares the branch HEAD
against what was merged. That absence is the bug.

## Goal

When a merged session's branch has been **rebased onto its base and carries
genuinely new work**, ShipIt should:

1. Drop the stale merged PR state (no more terminal "merged" card).
2. Treat the session as a normal active session ready for a **new** PR
   (auto-create if enabled, otherwise the "ready" card).
3. Keep the session **visible in Active** and off the fast merged-eviction
   ladder — these sessions are long-lived by user intention.

…while adding **no extra GitHub query load** for the common case (merged
sessions that are *not* progressing).

## Detection — squash-safe, history-free

The naive signal "HEAD is ahead of base" is **wrong**, and squash merges are
why. After a squash merge the branch's original commits never enter the base's
history — the base gets one new squashed commit instead. So:

- `git rev-list base..HEAD` (commit ancestry) is non-empty for a freshly
  squash-merged branch with **zero** new work → false positive on every squash.
- `git cherry` / patch-id matching also breaks: squash collapses N commits into
  one, so no individual patch-id matches the combined squash commit.

The signal must be **content/tree-based, gated on the rebase**:

> **A merged session has "progressed" iff**
> `merge-base(origin/<base>, HEAD) == rev-parse(origin/<base>)`
> **AND** a **two-dot** `git diff origin/<base>..HEAD` is **non-empty**.

Why this is squash-safe with no squash-specific code:

- The merge-base equality is really "has the branch been rebased onto the
  *current* base yet?" Once rebased, the merge base *is* the base tip.
- Rebasing is what drops the already-merged content. For a **squash** merge git
  replays the commits, sees the content already present in the base (as the
  squash commit), and drops them as empty; for a **regular** merge the commits
  are already there. Either way, post-rebase an unchanged branch has an **empty**
  two-dot diff → still "merged/done". The moment there's new work the diff goes
  non-empty → progressed.
- **Before** the rebase, `merge-base ≠ base tip`, so we stay conservative and
  keep showing "merged" — correct, because pre-rebase against a moved base there
  is no reliable content diff anyway (three-dot breaks on squash, two-dot picks
  up other people's commits). The existing `diffStatVsBranch` uses **three-dot**,
  which is exactly the squash-breaking comparison — we must not reuse it here.

The check is **local git only — no network.** It keys directly off the user's
own action (the rebase).

## Turn-gated evaluation — no extra GitHub load

Detection and re-arm run **only from the post-turn flow**, once per assistant
turn for that session. There is deliberately **no poller-tick sweep** over merged
sessions:

- The local check (merge-base + two-dot diff) is cheap and offline, so running
  it per turn is free.
- GitHub polling only **resumes** for a merged session if that local check says
  the branch genuinely progressed — i.e. only when there's a real new PR to
  track. Merged sessions that aren't moving cost zero GitHub queries.
- The terminal-only-rebase-with-no-turn case waits until the next turn. In
  practice that's immediate: in a chat IDE the rebase itself is an agent turn.

## Re-arm transition

When the post-turn flow sees `session.mergedAt` set, it runs the detection. If
progressed:

1. `sessionManager.clearMerged(id)` — **new** method, sets `merged_at = NULL` and
   stashes a display-only breadcrumb of the prior PR (number + url + title) for
   the "previously merged" note (mirrors how `setPrStatus` already clears
   `closed_at` on reopen). Clearing `merged_at` is what pulls the session back
   into **Active**, removes it from the Done group, gives it the gray fresh-session
   indicator, and reverts it to the normal (slower) disk-eviction ladder. No
   separate pin needed. The breadcrumb is display-only — it must not feed
   `resolvedAt()`, grouping, status color, or the eviction tier.
2. Poller `reArm(sessionId, supersededPrNumber)` — **silently** clear server
   state: delete `lastKnown`, drop from `mergedSessions`, `setPrStatus(id, null)`,
   and **record the superseded PR number** so the poller's own REST verify can't
   immediately re-promote it (see "Suppressing re-detection of the superseded
   PR"). Then `trackSession(sessionId)` to resume polling. Note: this
   deliberately does **not** reuse `clearPersisted`, because `clearPersisted`
   broadcasts a destructive `pr_status { removals: [sessionId] }` — see
   "Transport: why no removal broadcast" below.
3. `clearMerged(id)` + an **SSE** `session_list` rebroadcast (the merge callback
   already broadcasts `session_list` on the way *in*, from `onMergeDetectedCb` in
   `app-lifecycle.ts`). `clearMerged` only writes `merged_at = NULL`; the sidebar
   regroups from the session list, consumed on the client **only over SSE**
   (`useServerEvents`), so without a fresh `session_list` SSE broadcast the row
   stays in "Recently resolved" with the merge icon until a reload.
4. Fall through to the existing create/ready flow. Because the old PR is merged,
   `findPullRequest` (open-only) returns null, so `quickCreatePr` opens a **new**
   PR — but two of its assumptions break for a re-armed branch; see "Creating
   the new PR correctly". (Note: the open-only null only covers `quickCreatePr`'s
   *create* call. The poller's verify path uses an all-states query and would
   otherwise re-find the old merged PR — that's what the suppression below
   handles.)

If **not** progressed: return as today (stay merged, no GitHub call).

### Creating the new PR correctly

The shared create/ready path was written for a cold session, and two of its
assumptions are wrong for a re-armed (post-merge, rebased) branch:

- **Base branch must be the prior PR's base, not auto-detected `main`.**
  `quickCreatePr` picks the base by probing for `main`/`master`
  (`github.ts` ~308-312), and the "ready" diff is hardcoded to
  `git.diffStatVsBranch("main")` (`pr-lifecycle.ts` ~161). A session whose merged
  PR targeted `release/foo` would then show wrong diff stats and open the next PR
  against `main`. Re-arm is the one case where we *know* the correct base — it is
  the superseded PR's `baseBranch`. So the breadcrumb retained by `clearMerged`
  carries **`baseBranch`** too (number + url + title + base), and the re-arm path
  threads it into the ready diff and `quickCreatePr`'s `base`. (The generic
  `main`/`master` auto-detection for *cold* sessions is a pre-existing limitation
  and stays out of scope; re-arm just must not inherit it when it has better
  information.)

- **The push must tolerate a surviving, diverged remote branch.** Merge-time
  branch deletion (`markMergedAndPruneExcess`) is **best-effort** and many repos
  disable auto-delete, so the old remote branch often still exists pointing at
  the pre-merge commits. After a rebase the local branch's history no longer
  contains that ref, so `quickCreatePr`'s plain `git.push("origin", head)`
  (`github.ts` ~297) is rejected non-fast-forward and PR creation fails (error
  card, no PR). Fix: when creating the PR for a **re-armed superseded branch**
  (i.e. the suppression breadcrumb is set and there is no open PR), push with
  `--force-with-lease` (or delete-then-recreate the remote ref). This must be
  **gated on the re-arm state** so normal PR-update pushes are never
  force-pushed.

### Suppressing re-detection of the superseded PR

**This is the step that makes re-arm actually stick.** `trackSession` fires an
immediate `pollRepo({ force: true })`. The re-armed branch is absent from the
OPEN bulk view (its only PR is merged), so the poller runs `verifyMissingPr` →
`findPullRequestAnyState`, which queries
`?head=…&state=all&sort=updated&direction=desc&per_page=1` and returns the **old
merged PR** (the most-recent, and possibly only, PR on the branch). With
`merged_at` non-null the poller would re-promote: re-add to `mergedSessions`,
`setPrStatus(merged)`, broadcast a `merged` `pr_status` over SSE, and re-fire
`onMergeDetectedCb` (re-stamping `merged_at`). `applyPrStatusUpdates` has **no**
terminal-regress guard for a `merged` SSE update, so it clobbers the freshly
re-armed card back to merged and the row sinks to "Recently resolved" again —
the re-arm would survive at most one poll tick.

Fix: `reArm` records the superseded PR **number**, and `verifyMissingPr` ignores
a terminal (merged/closed) result whose `number` equals the recorded superseded
number — treating it as "no current PR" (session stays active, `ready` card
stands) instead of re-promoting. The suppression clears as soon as a PR with a
**different** number appears: once `quickCreatePr` opens the new PR, the
all-states query returns *it* (more recently updated, open) → number differs →
normal tracking resumes and the open card flows over SSE. The superseded number
is the same value as the `previousMergedPr` breadcrumb, so it is recorded once
and used for both the client note and this server-side suppression.

### Transport: why no removal broadcast, and where re-arm must live

The re-arm transition crosses **two independent client channels**, and the
design must be correct regardless of their relative arrival order:

- The new card from the post-turn flow (`emitPrLifecycleAfterCommit`) is emitted
  over the **per-session WebSocket** as `pr_lifecycle_update` → `updateCard`.
- Poller status (and any `pr_status` removal) travels over the **global SSE**
  channel → `applyPrStatusUpdates`.

Two consequences:

1. **No destructive removal broadcast.** A `pr_status` removal and the new WS
   card are on different transports with no cross-channel ordering. If the
   removal arrives *after* the new card, it deletes the freshly-shown card and
   the user is left with nothing. So re-arm clears the poller's server state
   *silently* (step 2) and relies on two non-racing convergence paths instead:
   reconnecting viewers get a clean snapshot (snapshot reconciliation already
   prunes poller-phase cards absent from `updates` — `applyPrStatusUpdates`
   `isSnapshot` branch), and the new card replaces the stale one (next point).
2. **The re-armed card must override the terminal guard.** `updateCard` refuses
   to regress a card from a terminal phase (`pr-store.ts` lines 311-314, asserted
   by `pr-store.test.ts`): existing `merged`/`closed` + incoming non-terminal →
   state unchanged. So the WS `ready`/`creating` card would be dropped while the
   merged card is still present. Fix: the re-armed card carries the
   `previousMergedPr` breadcrumb, and `updateCard`'s guard is amended to let a
   card carrying that breadcrumb replace a terminal card. This is order-
   independent: whether or not anything else has arrived, the breadcrumb card
   wins, and there is no later destructive message to undo it. (The auto-create
   **open** card needs no special-casing — it arrives over SSE via the poller,
   and `applyPrStatusUpdates` has no terminal-regress guard, so it overwrites the
   merged card for all viewers.)

**Where re-arm is orchestrated.** Steps 2–3 need `sseBroadcast` (for
`session_list`) and the poller — neither is available inside
`emitPrLifecycleAfterCommit` (its `PrLifecycleDeps` only carries the
per-connection WS `emit`). The detect → `clearMerged` → `reArm` →
`sseBroadcast("session_list")` step must run *before* delegating to
`emitPrLifecycleAfterCommit` for the card.

There are **two** post-turn entry points that call `emitPrLifecycleAfterCommit`,
and re-arm must cover both or a rebase in one of them silently fails to re-arm:

- the interactive WS-handler path (`ws-handlers/agent-execution.ts` —
  `postTurnPrFlow`), and
- the dispatch / system-turn path wired in `runner-registry-factory.ts` (used by
  spawned children, CI auto-fix, and programmatic `shipit session message`
  turns via `runSystemTurn`).

`sseBroadcast` and the poller are in scope at **both** (the dispatch site has
`RunnerRegistryDeps.sseBroadcast` and resolves the poller via
`getPrStatusPoller?.()`). Factor the detect → `clearMerged` → `reArm` →
`session_list` step into a **shared helper** that both `postTurnPrFlow` closures
call before `emitPrLifecycleAfterCommit`, rather than inlining it into only one.

**Secondary-viewer note (auto-create OFF only).** The `ready` card is
per-connection WS, so other open tabs don't receive it (this is pre-existing
`ready`-card behavior). With no destructive removal, their stale merged card
persists until they reconnect (snapshot prunes it) or the user opens the new PR
(SSE open card overwrites it). Acceptable; called out so it isn't a surprise.

## Auto-archive / visual-archive

Merge **never auto-archives** a session today — `onMergeDetectedCb` only calls
`markMergedAndPruneExcess` (sets `merged_at`, deletes the remote branch). The
workspace stays hot and the runner stays alive. So there is no archive call to
suppress.

Two reclaim/visibility surfaces still matter, and both are handled by the re-arm:

- **Visual archive** — the sidebar's top-N merged cap + Done group in
  `filterVisibleInSidebar`. A progressed session must stay in **Active**.
  Clearing `merged_at` makes `resolvedAt()` null → Active → visible.
  (`reopenedAfterResolve()` already floats a worked-in merged session back to
  Active even before re-arm, so there is no visible flicker.)
- **Disk eviction** — merged sessions evict faster (~2 days) than open ones
  (~14). Clearing `merged_at` reverts a progressed session to the normal active
  ladder, so it is not reclaimed out from under the user.

Requirement: **a merged-but-progressed session is never visually archived and
never fast-evicted.** It is treated as a plain live session.

## Re-armed card presentation

The re-armed session shows a **"previously merged"** breadcrumb, but its status
indicator is **gray — identical to a fresh / no-PR session**, not the merged
purple. The two parts come from different places:

- **Gray comes for free.** The sidebar row's "merged" look is not a color choice
  — it is the *presence* of `merged_at`, which places the row in the "Recently
  resolved" group under the `GitMergeIcon` (`SessionSidebar.tsx`). Clearing
  `merged_at` on re-arm pulls the row back into Active/New with no status glyph
  (the per-row indicator returns `null` for a session with no live PR card /
  CI). So "gray like a new session" requires **no extra styling work** — it is
  the natural consequence of the un-merge.
- **The breadcrumb needs a retained reference.** Because re-arm clears both
  `merged_at` and `pr_status`, the prior PR identity is gone. To still render
  "previously merged #N", retain a **lightweight breadcrumb** on the session —
  the prior PR number + url + title + **`baseBranch`**. The number drives both
  the client note and the server-side supersession suppression; `baseBranch` is
  used to target the new PR (see "Creating the new PR correctly"). The
  display-only parts must **not** feed `resolvedAt()`, grouping, the status
  color, or the eviction tier. It is
  surfaced on the re-armed **"ready"** card (`phase: "ready"`) as a subtle note,
  e.g. "Previously merged #N · ready for a new PR". The breadcrumb does
  double duty as the **override signal**: a card carrying `previousMergedPr` is
  what lets `updateCard` bypass its terminal-regress guard (see "Transport"
  below), so the re-armed card is accepted regardless of channel arrival order.

Net: a fresh-looking (gray, Active) session that quietly remembers it shipped
once.

## State transitions

```
                merge detected (verifyMissingPr)
   open  ───────────────────────────────────────▶  merged
                                                      │
                          post-turn: local detect     │  (per assistant turn)
                          progressed? ────────────────┤
                                                      │
                  no  ──────────────────────────▶  stay merged (no GitHub call)
                                                      │
                  yes ─▶ clearMerged + setPrStatus(null) + poller.reArm
                                                      │
                                                      ▼
                              Active, ready/creating ─▶ new open PR
```

## Edge cases

- **Base branch name.** Use the session's stored base (`baseBranch` from the PR
  summary / PR base), resolved as `origin/<base>`. `diffStatVsBranch` already
  relies on `origin/<base>` being present in the clone.
- **`origin/<base>` staleness.** Detection assumes the clone's `origin/<base>` is
  current; the user must have fetched to rebase, so it is. If `origin/<base>` is
  missing, detection returns false (stay merged) — fail safe.
- **Evicted workspace.** If a merged session sat long enough to be disk-evicted
  before the user returns, the local check can't run; treat as not-progressed
  until the workspace is rehydrated. Active use prevents this.
- **False merge positive (rate limits).** The poller documents that a persisted
  "merged" can be a false positive. Re-arm only fires on real new local work +
  rebased base, so a false-merged session that later shows new work simply gets a
  PR — desirable, not harmful.
- **Card wording.** Resolved (see "Re-armed card presentation").

## Key files

| Area | File | Change |
|---|---|---|
| Detection | `src/server/shared/git.ts` | Add two-dot diff + `advancedBeyondMergedBase(base)` (uses existing `mergeBase()`); do **not** reuse three-dot `diffStatVsBranch` |
| Un-merge | `src/server/orchestrator/sessions.ts` | Add `clearMerged(id)` (sets `merged_at = NULL`, stashes prior-PR breadcrumb); add breadcrumb column + `toRow`/`fromRow` + migration |
| Re-arm + suppression | `src/server/orchestrator/pr-status-poller.ts` | `reArm(sessionId, supersededPrNumber)` — **silently** clear `lastKnown` + `mergedSessions` + `setPrStatus(null)`, record superseded PR number, then `trackSession`. `verifyMissingPr` ignores a terminal result whose `number` == the recorded superseded number until a different-numbered PR appears |
| Detection check + post-turn | `src/server/orchestrator/services/pr-lifecycle.ts` | Detection helper + pass the `previousMergedPr` breadcrumb onto the `ready`/`open` card; relax the `if (session.mergedAt) return` guard for the progressed case; use the breadcrumb's `baseBranch` for the ready diff (not hardcoded `"main"` at ~161) |
| New-PR create | `src/server/orchestrator/services/github.ts` | For a re-armed branch: target the breadcrumb `baseBranch` (not auto-detected `main`/`master` at ~308-312); push with `--force-with-lease` (gated on re-arm state) so a surviving diverged remote branch doesn't reject the push at ~297 |
| Re-arm orchestration | **shared helper** called by both `postTurnPrFlow` sites — `ws-handlers/agent-execution.ts` AND `runner-registry-factory.ts` (dispatch/system-turn) | Both have `sseBroadcast` + poller in scope: detect → `clearMerged` → `reArm` → `sseBroadcast("session_list")` → then card emit. Wiring only one drops re-arm for spawned/CI/programmatic turns |
| Card | `src/client/components/PrLifecycleCard.tsx` | Render "Previously merged #N" note on the re-armed `ready`/`open` card |
| Sidebar | `src/client/components/SessionSidebar.tsx` | No styling change — gray/Active is the natural result of cleared `merged_at`; requires the `session_list` SSE rebroadcast to regroup live, not just on reload |
| Client store | `src/client/stores/pr-store.ts` | Amend `updateCard`'s terminal-regress guard (lines 311-314) to let a card carrying `previousMergedPr` replace a `merged`/`closed` card (order-independent override; no removal broadcast to race it) |

## Testing

- `git.test.ts` — detection matrix: {squash, regular} × {rebased, not-rebased} ×
  {new work, clean}. Squash+rebased+clean → false; squash+rebased+new-work →
  true; any not-rebased → false.
- `sessions.test.ts` — `clearMerged` clears `merged_at`; session returns to
  Active grouping.
- Poller integration — merged → progressed → re-armed (resumes tracking); merged
  → not progressed → no GitHub call.
- Post-turn integration — merged+progressed creates a new PR; merged+clean stays
  merged and visible/active per the requirement above.

## Open questions

_None — see "Re-armed card presentation"._

## Implementation notes (as built)

- **Detection** lives in `GitManager`: `diffStatTwoDot(ref)` (a TWO-dot
  `<ref>..HEAD` stat, deliberately distinct from the three-dot
  `diffStatVsBranch`) and `advancedBeyondMergedBase(baseBranch)` (merge-base ==
  `origin/<base>` tip AND non-empty two-dot diff). Pre-rebase or missing
  `origin/<base>` → false (fail-safe). Matrix coverage in
  `git-rearm-detect.test.ts` (squash/regular × rebased/not × work/clean).
- **Breadcrumb** is `SessionInfo.previousMergedPr` (`{ number, url, title,
  baseBranch }`), persisted in the new `sessions.previous_merged_pr` column
  (migration appended to `database.ts`). `SessionManager.clearMerged(id,
  breadcrumb)` sets `merged_at = NULL` and stashes it. Display-only + the
  poller's suppression key + the new-PR base; it does NOT feed `resolvedAt()`,
  grouping, status color, or eviction.
- **Shared helper** `services/pr-rearm.ts#detectAndReArmMergedSession` is the
  single re-arm entry point, called by BOTH `postTurnPrFlow` sites
  (`ws-handlers/agent-execution.ts` and `runner-registry-factory.ts`) before
  `emitPrLifecycleAfterCommit`. It reads the prior PR's base/number from
  `prStatusPoller.getStatus` (the merged snapshot, seeded from persisted on
  restart), runs the local git detection, then `clearMerged` → `reArm` →
  `sseBroadcast("session_list", { sessions })`.
- **Poller** gained `reArm(sessionId, supersededPrNumber)` (silent: clears
  `lastKnown`/`lastPrNodes`/`mergedSessions`/`verifiedAbsent` + `setPrStatus(null)`,
  records the superseded number, then `trackSession`) and a
  `supersededPrNumbers` map. `verifyMissingPr` ignores a TERMINAL result whose
  number equals the recorded superseded number; the suppression clears the
  moment a different-numbered PR appears (open bulk-view match OR a differently-
  numbered verify result). `loadPersisted` re-seeds the map from
  `previousMergedPr` breadcrumbs over `list()` (a re-armed session is always in
  the visible Active list, so no archived-row scan is needed) so the suppression
  survives a restart before the new PR exists.

- **Suppression must not arm the `verifiedAbsent` debounce (terminal-convergence
  bug fix, SHI gray-badge report).** `verifyMissingPr` now returns its resting
  outcome (`"absent" | "open" | "terminal" | "suppressed"`), and both callers —
  `pollRepo`'s missing-PR branch and `forceVerifySessionPrState` — arm
  `verifiedAbsent` for every outcome **except** `"suppressed"`. Why: a re-armed
  session whose only branch PR is still the superseded merged one returns
  `"suppressed"`, and the old code armed the single-probe debounce after it. If
  the session's NEW PR was then opened **and merged externally** (e.g. via the
  `gh pr create` shim, then merged on GitHub) without ever being observed OPEN in
  the bulk view — common when the tab is closed, or when it opens-and-merges
  between two polls — nothing ever cleared `verifiedAbsent` (it only clears on a
  bulk-view reappearance or a forced refresh), so every periodic poll skipped the
  REST verify and the merge of the *different-numbered* new PR was never caught.
  The session stayed with no PR snapshot — the gray "Branch" fallback in
  `PrStateBadge` — instead of converging to GitHub's terminal state. The
  superseded suppression also never cleared (it only clears when a
  different-numbered PR is *observed*), so it was self-reinforcing. Leaving the
  debounce un-armed for the suppressed case lets the next periodic poll re-verify
  and promote the moment `findPullRequestAnyState` returns the new (now-terminal)
  PR — no forced refresh / viewer attach required. The `"open"` and `"absent"`
  outcomes still arm the debounce (a known open PR is sustained by the
  coverage-alias query; a genuinely absent branch must not re-probe every poll),
  so steady-state REST load is unchanged for non-re-armed sessions. Coverage:
  `pr-status-poller.test.ts` "converges to merged when the NEW PR opens and merges
  between polls (never seen open)".
- **New-PR creation**: `quickCreatePr` takes a `reArm?: { baseBranch?;
  forceWithLease? }` arg — re-arm targets the prior PR's base (not auto-detected
  main/master) and pushes with `--force-with-lease` (the old remote branch often
  survives and the rebased branch diverges). `emitPrLifecycleAfterCommit` threads
  `previousMergedPr` onto the `creating`/`ready`/`open`/`error` cards and uses its
  base for the ready diff.
- **Client**: `WsPrLifecycleUpdate` / `PrCardState` carry `previousMergedPr`;
  `pr-store.updateCard`'s terminal-regress guard lets a card carrying it replace
  a stale `merged`/`closed` card (order-independent — re-arm broadcasts no
  destructive removal to race it). `PrLifecycleCard` renders a subtle
  "Previously merged #N" breadcrumb (linked to the prior PR) on the re-armed
  ready/open card; the gray/Active sidebar treatment is the natural result of the
  cleared `merged_at` (no sidebar styling change).
- **Not a chat-history card**: the breadcrumb lives on the *session* row (like
  `pr_status`), not the `messages` table, so the `CARD_MESSAGE_FIELDS` /
  chat-history round-trip machinery does not apply.
- **`gh pr create` shares the detection (nicolasalt/shipit#1357).** The shim path
  (`services/github.ts#agentCreatePr`) used to short-circuit on a branch PR in
  ANY state, so a merged PR blocked a new one even after a rebase + new work —
  the agent got the dead merged URL and could not surface follow-up work. Fixed
  to gate the closed/merged short-circuit on the SAME `advancedBeyondMergedBase`
  check: an **open** PR still wins (push + return), a **closed/merged** PR blocks
  only when the branch hasn't progressed; when it HAS progressed, `agentCreatePr`
  force-pushes (`--force-with-lease`, the old remote branch may survive diverged)
  and opens a NEW PR targeting the prior PR's base. Because the same condition
  gates both, opening the new PR and the post-turn `detectAndReArmMergedSession`
  fire together: the new open PR is then picked up by the resumed poller and
  overwrites the merged card. Coverage in `agent-driven-pr.test.ts`
  ("creates a NEW PR when the prior PR merged but the branch progressed").

- **Force-push lease must be computed fresh, not bare (bug fix).** The re-arm
  force push above used a bare `--force-with-lease`, which leases against the
  local remote-tracking ref `refs/remotes/origin/<branch>`. After the merge that
  ref is stale — the remote branch was deleted at merge (auto-delete / ShipIt's
  best-effort prune) or simply never re-fetched — so git rejected EVERY re-arm
  push with `[rejected] (stale info)`, even right after a manual `git fetch`, and
  the follow-up PR could never be opened. `GitManager.forcePush` now reads the
  remote's LIVE tip via `git ls-remote` (`remoteBranchSha`) and leases against
  that explicit value (`forcePushWithLease`); when the remote branch is gone it
  creates the ref with a plain push (nothing to clobber). This keeps the lease's
  protection — a genuine concurrent move underneath a known expected sha is still
  rejected — without the staleness. All force-push sites funnel through
  `forcePush` (re-arm `quickCreatePr`/`agentCreatePr`, rebase-driver
  auto-resolve), so they all get the fix. Coverage:
  `src/server/shared/git-force-push-lease.test.ts`.

  Separately, the orchestrator-side push surfaced
  `shipit-git-credential ...: not found` noise: session workspaces carry a local
  `credential.helper` pointing at the in-container broker, which the orchestrator
  image doesn't install (docs/192). A silent no-op shim is now baked into the
  orchestrator images (`docker/Dockerfile.{prod,dev,dogfood}`) so git's
  `store`/`erase` calls to the broker are absorbed; the orchestrator still
  authenticates via its own global inline helper.
