---
issue: https://linear.app/shipit-ai/issue/SHI-253
title: Self-merge wake — continue a session automatically when its own PR merges
description: A session arms an intent-carrying watch on its own PR and is woken by one system turn — on a freshly reset branch — once that PR merges.
---

# Self-merge wake (`shipit session notify-on-merge --self`)

## Problem

docs/196 wakes a **parent** session when a **child's** PR merges. Nothing wakes a
session when its **own** PR merges.

For the "several PRs in a row from one session" workflow that is the missing half.
The user says "ship this, then do the API half", the PR opens, and then the chain
stops dead: the merge happens hours or days later, and the only way work resumes is
the user noticing and sending another message. Worse, today's merge path
deliberately **quiets** the session — `markMergedAndPruneExcess` marks it merged and
deletes the remote head branch, `useSessionGrouping` sinks the row into "Recently
resolved", and `computeAttentionReason` is fed `resolved: true` so `useAttentionInfo`
suppresses the attention bar. Every one of those is correct under the assumption the
whole merge path is built on — **1 session = 1 PR = done** — and that assumption is
what breaks for a session that is merely *between* PRs.

## Scope — an armed intent, not a merge notification

This feature covers **only** the case where a follow-up was explicitly stated.
Notifying the user on *every* own-merge was considered and **rejected**:

- We cannot distinguish "this session is finished" from "this session is between
  PRs", so any persistent signal nags every genuinely-shipped session forever.
- The browser-notification pipeline is **state-derived**, not event-derived:
  `useAttentionNotifications` fires `notify()` off a `null → reason` transition of
  `computeAttentionReason`, the same function that drives the sidebar bar (they are
  deliberately coupled so they "can never disagree"). Adding a merged reason there
  buys a notification *and* an amber needs-attention bar on every merged session,
  sitting in the group literally named "Recently resolved".

An edge-triggered notification (one-shot SSE → `notify()`, bypassing
`computeAttentionReason`) remains a possible separate feature. It is not this one,
and this design does not depend on it.

## Model

```
shipit session notify-on-merge --self --then "<instruction>"
  → persist an armed self-watch + surface a cancellable arm card
  → (turn ends; hours or days pass; the user merges the PR)
  → poller detects the merge → merge bookkeeping completes
  → reset the branch to the fresh base (+ force-push heal)
  → dispatch ONE system turn carrying <instruction>
  → the turn opens a new PR and stops
```

The `--then` payload is the whole difference from docs/196. A child wake-turn can
say "proceed with the planned integration" because the *dependency* is the intent; a
self-wake has no such structural intent, so without a captured instruction it has
nothing to act on.

The agent arms this **only** when the user has stated a follow-up. It is never
armed by default, and never inferred from the mere existence of a PR.

## Why the firing point is `onMergeDetectedCb`, not `onPrTerminalState`

The obvious hook is the one docs/196 already uses. For a self-watch it is **wrong**.

In `verifyMissingPr` the terminal-merge block fires three things in this order, all
fire-and-forget (`.catch()`, never awaited):

1. `onPrTerminalState` — the docs/196 watch hook
2. `setMergedHeadSha(sessionId, pr.head_sha)` — docs/218's reset safety anchor
3. `onMergeDetectedCb` → `markMergedAndPruneExcess` — sets `mergedAt`, **deletes the
   remote head branch**

A self-wake hung off (1) therefore races its own preconditions: `mergedAt` is unset,
`mergedHeadSha` is not yet stored, and the remote branch is being deleted
concurrently with the turn it just started. Every clause of docs/218's reset gate
fails, so the woken turn lands on an un-moved branch at the merged tip.

The correct site is **inside `onMergeDetectedCb`, after `markMergedAndPruneExcess`
resolves** — immediately next to the existing `emitResetEligibleSignal` call. That
is not a coincidence: "this session is now reset-eligible" is exactly the
precondition a self-wake needs, so it wants the same site. docs/196's
`onPrTerminalState` path stays untouched for child watches.

## Why the pre-turn reset must be invoked explicitly

docs/218's reset is not merely *gated off* for system turns — it is on a different
code path. `autoResetMergedBranchOnContinue` is called from `runAgentWithMessage`
(`ws-handlers/agent-execution.ts`); a dispatched system turn runs through
`session-runner.ts` `dispatch` → `dispatched-turn.ts` and never passes it.

So the self-wake delivery calls `autoResetMergedBranchOnContinue` itself, before
`dispatch`: fetch → re-gate → `reset --hard origin/<base>` → `forcePush` heal. The
force-push heal is not optional here; `markMergedAndPruneExcess` has already deleted
the remote branch, and docs/218 Phase 4 records what happens without it (plain
debounced auto-pushes land as silently-dropped non-fast-forwards).

**This narrows docs/218's "interactive path only" boundary, deliberately.** That
boundary was drawn because "a destructive reset underneath an automated message is
more surprising than helpful" — the surprise being absent consent. Here the
**arming is the consent**, and it is more explicit than the composer checkbox it
substitutes for: the user stated the follow-up, the agent echoed it into the watch,
and the arm card shows it pending with a Cancel. Every safety clause still applies
unchanged (`HEAD === mergedHeadSha`, clean tree, on `session.branch`, no in-progress
sequencer), and the failure mode is unchanged too: gate fails → no reset → the turn
runs on the un-moved branch.

## State machine

Stored in a **separate `self_merge_watch` column**, not by extending `merge_watch`.
That column holds one `SessionMergeWatch` keyed by the child id, and a session can
be simultaneously watched by its parent *and* self-watching — one slot collides.
A sibling column leaves docs/196's tested state machine untouched instead of
migrating it to a list.

```
armed ──merge observed──▶ merge-observed ──wake-turn RAN──▶ delivered  (terminal)
  │                              ▲                              │
  │                              └────restart re-fires──────────┘
  ├──PR closed unmerged──▶ expired    (terminal, NO wake-turn)
  └──user clicks Cancel──▶ cancelled  (terminal)
```

`armed → merge-observed → delivered` is docs/196's machine verbatim, including the
load-bearing rule that **`delivered` means "the turn ran", not "the turn was
enqueued"** — stamped only from the wake-turn's `onTurnComplete`, which rides the
in-memory queue so a busy session reaches `delivered` in-process. Getting this wrong
is what produced docs/196's two historical bugs (a stranded parent, then duplicate
wake-turns on every restart); reusing the machine rather than re-deriving it is the
point.

`reconcilePending` on boot re-fires `armed` / `merge-observed` watches from the
persisted PR snapshot. `hasPendingMergeWatch()` — already wired into
`PollingGlobalGate` via `anyAutonomousActionInFlight()` — must also count pending
**self**-watches, and it matters more here than for children: a session waiting on
its own merge has no viewer, so without it the gate closes and the merge is never
observed until someone opens a tab.

### `expired` — closed-without-merge does **not** wake (decided)

docs/196 wakes the parent on a closed-unmerged child, deliberately, so it cannot
proceed as if the work shipped. A self-watch does the opposite: it drops the intent
and records that it expired, with **no turn**. The reason is mechanical, not
aesthetic — the reset gate requires `mergedAt` + `mergedHeadSha`, and a closed PR
sets `closedAt` instead. The branch would stay exactly where it is, so a woken
follow-up would stack new work on top of the very commits that were just rejected.
Doing nothing is strictly better.

The cost is that an armed intent expires without a turn, which is why the expiry is
**not** silent: the arm card patches to `expired` and states the follow-up that was
dropped, so scrolling back shows what did not happen.

## The arm card

The arm is **do-then-surface** (mirroring `shipit issue create`): the agent arms it
and a card appears in the transcript stating the captured follow-up, with a
**Cancel** that works any time before the merge.

It is a small **lifecycle** card, not a one-shot record — `armed` → `delivered` /
`expired` / `cancelled` — so it follows the `upsertReleaseCard` precedent rather
than the plain `emitChatCard` one. That precedent is the right one specifically
because its transitions "can run outside a turn (an async poll transition), which is
exactly why a finalized-row patch is safe" — and every transition here except the
initial arm fires from the poller or a user click, outside any turn.

Full at-rest contract (the recipe is self-enforcing via two guard tests): typed
`selfMergeWatch` field on `PersistedMessage`, `self_merge_watch_card` column +
`toRow`/`fromRow` + `database.ts` migration, rehydrate in `loadSessionHistory`,
register in `CARD_MESSAGE_FIELDS` + `EVERY_OPTIONAL_FIELD_MESSAGE`, and add the WS
type to `TRANSCRIPT_SCOPED_MESSAGES` so the card can't land in a foreign transcript.

Cancel follows the bug-report / egress card-resolution precedent: a WS message from
the card → handler → clear the watch + patch the card to `cancelled`.

## One turn, one PR, then stop (decided)

The woken turn does the follow-up and opens a new PR (docs/202's re-arm handles the
card: after the reset `HEAD == origin/<base>`, the turn commits, and the re-arm
opens a **new** PR on the same branch — which is exactly the sequential-PR shape
this feature exists for). It then **stops**.

The woken turn must not arm another self-watch, so a merge cannot start an unbounded
unattended chain. One unattended turn per merge, each ending at a PR that waits for
a human. Chaining was considered and rejected: it compounds staleness and every link
after the first is unwatched.

## Staleness

The follow-up may be stale by the time a human merges days later. This is **not**
specific to self-watches — docs/196 has the same exposure and already mitigates it
in `buildWakeTurnPrompt` ("*unless the user has since redirected you*" + "*review
this session's earlier messages*"). The mitigation must stay **shared**: add a
`self` branch to that existing prompt builder rather than writing a parallel one, so
the escape clause cannot drift between the two.

The one asymmetry is how likely staleness is to bite, and it argues for keeping this
opt-in. A child watch is armed against a **dependency** — once it merges, integrating
it is usually still right, because the structural reason it was armed hasn't
changed. A self-watch is armed against a **plan**, and plans are exactly the thing
that goes stale.

## Edge cases

- **PR not open yet when armed** → arm and wait (same as docs/196).
- **PR already merged when armed** → the poller won't re-observe it, so the register
  route fires a one-shot `checkAndFireNow`, as docs/196 does.
- **Container idle-reaped / evicted workspace** → `wakeSessionWithTurn` owns the
  stale-runner teardown, container resume, and credential refresh; it throws on a
  boot failure, leaving the watch at `merge-observed` for the next poll to retry.
- **Reset gate fails** (dirty tree, `mergedHeadSha` absent, detached HEAD,
  in-progress sequencer) → no reset, but the turn **still runs**; the prompt states
  the branch was not moved so the agent doesn't assume a fresh base.
- **Session archived before the merge** → drop the watch silently at delivery and
  refuse at arm time, mirroring docs/196's both-ends enforcement of "an archived
  session receives nothing".
- **User keeps working in the session while armed** → the watch survives; the
  escape clause covers redirection (see "No auto-disarm" under Resolved decisions).
- **docs/202 re-arm before the merge** (branch rebased and gains new work, clearing
  `mergedAt`) → the watch stays armed against the *new* PR, which is the intuitive
  reading; the fire-once machine still guarantees one delivery.

## Flow

```
shipit session notify-on-merge --self --then "<instruction>"   (agent-shim/shipit-session.ts)
  → POST /agent-ops/session/notify-on-merge/self               (agent-ops-routes.ts)
  → POST /api/sessions/:id/self-merge-watch                    (api-routes-session.ts)
  → registerSelfMergeWatch(...)  — persists armed watch + arm card + checkAndFireNow

PR poller: verifyMissingPr detects merged
  → setMergedHeadSha → onMergeDetectedCb → markMergedAndPruneExcess (awaited)
      → handleSelfMerge(sessionId)                              (merge-watch.ts)
           ├─ autoResetMergedBranchOnContinue  (reset + force-push heal)
           ├─ wakeSessionWithTurn → dispatch({ systemTurn: true })
           └─ onTurnComplete → state = delivered, card → delivered
```

## Key files

| Area | File | Change |
|---|---|---|
| Watch state | `src/server/orchestrator/sessions.ts` | `self_merge_watch` column + `setSelfMergeWatch` / `getSelfMergeWatch`; extend `listPendingMergeWatches` |
| Persist | `src/server/shared/database.ts` | `self_merge_watch` + `self_merge_watch_card` columns + migrations |
| Type | `src/server/shared/types/domain-types/session.ts` | `SessionInfo.selfMergeWatch`; `followUp` + `expired`/`cancelled` on the watch type |
| Fire point | `src/server/orchestrator/app-lifecycle.ts` | Call `handleSelfMerge` inside `onMergeDetectedCb` after `markMergedAndPruneExcess`, beside `emitResetEligibleSignal` |
| Delivery | `src/server/orchestrator/merge-watch.ts` | `handleSelfMerge`; reuse the state machine, `reconcilePending`, `checkAndFireNow`; `self` branch in `buildWakeTurnPrompt` |
| Reset | `src/server/orchestrator/services/pre-turn-reset.ts` | Reuse `autoResetMergedBranchOnContinue` unchanged from the delivery path |
| Wake | `src/server/orchestrator/wake-session.ts` | Reuse `wakeSessionWithTurn` unchanged |
| Poll gate | `src/server/orchestrator/polling-global-gate.ts` | Count pending self-watches in `anyAutonomousActionInFlight()` |
| Arm + cancel | `src/server/orchestrator/api-routes-session.ts`, `ws-handlers/` | Register route; `cancel_self_merge_watch` WS handler |
| Card persist | `src/server/orchestrator/chat-history.ts` | `upsertSelfMergeWatchCard` (the `upsertReleaseCard` pattern) |
| Agent surface | `src/server/session/agent-shim/shipit-session.ts`, `agent-ops-routes.ts` | `--self` + `--then` on the existing `notify-on-merge` subcommand + worker relay |
| Client | `src/client/components/`, `hooks/message-handlers/index.ts`, `components/visual-elements.ts` | Card component + handler; `CARD_MESSAGE_FIELDS`; `TRANSCRIPT_SCOPED_MESSAGES` |
| Agent docs | `src/server/shipit-docs/sessions.md` | Document `--self --then` and the one-turn-one-PR rule |

## Testing

- `merge-watch.test.ts` — self-watch machine: fire-once; `delivered` only after the
  wake-turn *runs*; busy session drains in-process; closed-unmerged → `expired` with
  **no** dispatch; cancel → `cancelled`; archived session dropped; reconcile
  re-fires a watch lost to a restart before the turn ran, without a second card.
- New delivery test — the reset runs **before** dispatch; a failed gate still
  dispatches; a `wakeSessionWithTurn` throw leaves the watch at `merge-observed`.
- Ordering regression — a self-watch armed on a session whose merge is detected sees
  `mergedAt` **and** `mergedHeadSha` already set when it fires (guards the
  `onPrTerminalState`-vs-`onMergeDetectedCb` race this design turns on).
- `polling-global-gate.test.ts` — a pending self-watch keeps the gate open with no
  viewer.
- Integration — arm → merge → branch reset + one system turn + new PR; the woken
  turn does not arm another watch; cross-session isolation of the card.
- `chat-history.test.ts` / `visual-elements.test.ts` — card round-trip, no duplicate
  on replay, `CARD_MESSAGE_FIELDS` + `EVERY_OPTIONAL_FIELD_MESSAGE` registration.

## Resolved decisions

- **Intent-armed only; a general own-merge notification is out of scope** (and would
  need a separate edge-triggered path, not `computeAttentionReason`).
- **Fire from `onMergeDetectedCb` after the merge bookkeeping**, not from
  `onPrTerminalState` — otherwise the wake races `mergedHeadSha`, `mergedAt`, and the
  remote-branch deletion.
- **Separate `self_merge_watch` column**, so docs/196's tested machine is untouched.
- **Call `autoResetMergedBranchOnContinue` from the delivery path**, narrowing
  docs/218's interactive-only boundary; the arming is the consent, and the full
  safety gate still applies.
- **Closed-without-merge → `expired`, no wake-turn** (the branch can't be reset, so
  a follow-up would stack on rejected commits). Expiry is recorded on the card, not
  silent.
- **Cancellable arm card**, do-then-surface, lifecycle-patched via the
  `upsertReleaseCard` pattern.
- **One turn, one PR, then stop** — the woken turn must not arm another self-watch.
- **Staleness mitigation shared with docs/196** via one `buildWakeTurnPrompt`.
- **No auto-disarm on user redirect.** There is no reliable "the user changed their
  mind" signal — any implementation is a heuristic over message content or commit
  shape, and a wrong guess drops work the user explicitly asked for *silently*,
  which is the worst available failure mode. The two escape hatches are both
  explicit: the arm card's Cancel, and the prompt's escape clause, which puts the
  judgment in the woken turn where the whole transcript is in scope.
  **Revisit if** watches are observed firing against abandoned plans often enough
  that the silent-drop risk becomes the lesser one.
- **No global setting.** `autoFixCi` / `autoResetMergedBranch` need global switches
  because they fire **without** per-use consent; this fires only from an explicit
  arm and can be cancelled from the card, so a third opt-out is speculative.
  **Revisit if** someone asks for a blanket "never run unattended turns" switch
  spanning all of these behaviors — that is a cross-feature setting, not this
  feature's.

## Open questions

_None — see "Resolved decisions"._
