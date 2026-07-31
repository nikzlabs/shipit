---
issue: https://linear.app/shipit-ai/issue/SHI-253
title: Self-merge wake — continue a session automatically when its own PR merges
description: A session opts in to being told when its own PR merges, and the wake-turn instructs the agent to rebase and continue. ShipIt performs no git work.
---

# Self-merge wake (`shipit session notify-on-merge --self`)

## Problem

docs/196 wakes a **parent** session when a **child's** PR merges. Nothing wakes a
session when its **own** PR merges.

For a session that ships several PRs in a row that is the missing half. The user
says "ship this, then do the API half", the PR opens, and the chain stops: the merge
happens later — by hand from ShipIt, by hand from GitHub, or via auto-merge once CI
goes green — and work only resumes when someone notices. Today's merge path
deliberately **quiets** the session (`markMergedAndPruneExcess` marks it merged and
deletes the remote head branch; the sidebar sinks it into "Recently resolved";
`useAttentionInfo` suppresses the attention bar), because the whole path assumes
**1 session = 1 PR = done**. That assumption is right for most sessions and wrong for
the ones that continue.

## Shape — a message, not a git operation

**ShipIt performs no git work.** The delivery is a message; the rebase is ordinary
agent work inside an ordinary turn.

```
shipit session notify-on-merge --self --then-file -   (armed only when the user stated a follow-up)
  → persist the armed watch + surface it in the transcript
  → (the PR merges — by hand or by auto-merge; the source is irrelevant)
  → poller detects it → merge bookkeeping completes
  → deliver a wake-turn via the existing child-message path
       "PR #N merged into <base>. Your branch still points at the merged tip and
        its remote branch is gone. Reset to the latest base and force-push with
        lease before doing anything else. Then: <follow-up>."
  → the agent does that as its first actions, inside the turn
```

This is deliberately docs/196's design pointed at the session itself. The delivery
machinery is the one that already exists and has since been repaired five times
(SHI-254, 255, 258, 259, 260) — no new delivery path, no second retry supervisor.

### Why ShipIt doing the git work was the expensive idea

An earlier draft had ShipIt run `fetch` → `reset --hard` → `forcePush` **before**
dispatching the turn, reusing docs/218's `autoResetMergedBranchOnContinue`. Because
that ran outside turn serialization, it dragged in: a session-level preparation lease
(nothing owned the session during the reset), write-ahead reset staging (a crash
mid-reset wasn't recoverable by ordinary turn logic), a per-workspace git-mutation
coordinator (a debounced auto-push could be in flight), a `blocked` state with a
resume contract, workspace-restoration ordering, and a consent-policy argument about
narrowing docs/218's interactive-only boundary.

Every one of those requirements existed *because ShipIt mutated the repo outside a
turn*. Moving the work inside the turn deletes all of them. A crash mid-rebase is
now just a failed turn — the failure mode the system already handles constantly and
which is visible in the transcript.

### One path for every merge

Manual-from-ShipIt, manual-from-GitHub, and auto-merge are **not** distinguished.
`verifyMissingPr` observes a merged PR identically in all three cases, so a single
path costs nothing and avoids two behaviours to reason about and test. An earlier
draft proposed treating a ShipIt-side merge as a direct trigger (the orchestrator
knows immediately, the container is warm); that is an optimization that buys latency
at the cost of divergence, and it is explicitly rejected.

Auto-merge (`auto-merge-manager.ts`, a per-session opt-in) means the merge really can
land with nobody watching, so the delivery must survive an idle-reaped container and
an orchestrator restart. It does: that is what SHI-258's retry supervisor is for.

## Opt-in, always

The watch is armed only when the user has stated a follow-up, and the agent arms it
explicitly. It is never implied by the existence of a PR.

Most sessions are single-PR and then archived. An unconditional wake would give every
finished session a turn that reads "your PR merged", concludes there is nothing to
do, and leaves a wasted turn and a noisy transcript behind — on every shipped session.
Opt-in also means the follow-up is **captured at arm time** rather than inferred from
scrollback, which is what makes the wake-turn self-describing.

### Arm surface

`shipit session notify-on-merge --self --then-file -`

`--then-file` (with `-` for stdin), **not** an inline `--then`. The shim already
rejects inline prompts because the shell evaluates backticks, `$(…)`, and quotes
before ShipIt sees them — the same reason `gh pr create` takes `--body-file -`.
Validate non-empty and bounded length in both the shim and the orchestrator; require
exactly one of `<child-id>` or `--self`; require `--then-file` with `--self`.

Refuse to arm when: the session is archived; a non-terminal watch already exists; or
the session has no branch or no parseable GitHub remote (otherwise the watch can
never be polled, while still holding the polling gate open).

## Delivery

**Fire from `onMergeDetectedCb`, after `markMergedAndPruneExcess` resolves** — not
from docs/196's `onPrTerminalState` hook. In `verifyMissingPr` that hook is launched
*before* `setMergedHeadSha` and *before* the merge bookkeeping, all fire-and-forget.
Waking there would race the remote-branch deletion, so the agent could reset and
force-push a branch that is deleted a moment later. `app-lifecycle.ts` genuinely
awaits `markMergedAndPruneExcess`, so firing after it is ordered correctly.

**Closed-without-merge expires the watch and wakes nothing.** `onMergeDetectedCb`
only fires for merged outcomes, so this transition must fan out from
`onPrTerminalState` — safe there precisely because it starts no turn. The work did
not ship, so the follow-up's precondition is false; waking would invite the agent to
build on commits that were just rejected. The expiry is recorded on the card, not
silent.

**Pin the watch to the PR it was armed against.** If docs/202's re-arm gives the
session a *new* PR before delivery, the captured instruction must not silently
transfer from PR #1 to PR #2 — that would run a follow-up conditioned on one piece of
work when a different one merged. Bind to `{prNumber, headSha}` on first observation
and never retarget; if the anchor is superseded, move to a visible terminal state
rather than waiting for an unrelated PR. This needs the poller to carry the PR
identity into the merge callback, which today receives only `sessionId`.

**Delivery failures reuse SHI-258.** A wake that throws (container won't boot,
credentials stale) is retried on the existing backoff and terminates in
`delivery-failed` with a persisted card. No new supervisor.

## The wake prompt

Self-describing, carrying the PR ref, base branch, merge SHA, and the captured
follow-up. Three things it must state, because the agent cannot infer them:

1. **The branch still points at the merged tip.** Reset to the latest base — the
   merged commits are already in the base, so there is nothing to replay.
2. **Force-push with lease.** `markMergedAndPruneExcess` deletes the remote head
   branch best-effort. If the delete succeeded a plain push recreates it; if it
   failed, the remote still holds the old commits and the debounced auto-push lands
   as a silently-dropped non-fast-forward — the exact bug docs/218 Phase 4 hit.
3. **Do not re-apply shipped work**, and proceed with the follow-up *unless the user
   has since redirected you* — the escape clause docs/196 already carries, shared via
   one `buildWakeTurnPrompt` rather than a parallel builder, so it cannot drift.

**Considered: a `shipit` subcommand wrapping the reset.** Instructions leave the
agent to reconstruct base selection, lease handling, and the deleted-branch case each
time — which is what docs/218 automated away for the interactive path. A thin
subcommand over the existing tested logic would let the agent invoke correct code
while still doing the work inside its own turn. Not required for v1; recorded as the
hardening step if the prompt route proves unreliable in practice.

## Storage

A distinct `SelfMergeWatch` with its own column. docs/196's `SessionMergeWatch`
structurally requires `parentSessionId` and child-specific states, its
`listPendingMergeWatches` returns `{ childSessionId, watch }`, and startup
reconciliation feeds every result to the **child** handler — so reusing the type or
the list would misroute self entries. A session can also be watched by its parent
*and* self-watching at once, which collides on the single existing slot.

States: `armed → delivered`, with terminal `expired` (PR closed unmerged),
`cancelled` (user), `superseded` (anchor PR replaced), and `delivery-failed`
(SHI-258's cap). Pending-state classification must be one shared exhaustive predicate
used by the list query, the retry supervisor, and `PollingGlobalGate` —
`isTerminalWatchState` controls none of those today; `listPendingMergeWatches`
independently hard-codes `armed || merge-observed`.

There is deliberately **no** `completed-without-pr` state. Whether the follow-up
produced a PR is the PR card's business; the watch's only question is whether the
wake-turn ran.

## The arm card

Arming is do-then-surface: a persisted card stating the captured follow-up, with a
**Cancel** that works until the merge. A watch can sit armed for days, so "what is
armed and how do I stop it" needs an affordance.

Emit via `emitChatCard`, not the `upsertReleaseCard` append pattern — the arm happens
mid-turn (an agent tool call), which is exactly the side-channel shape CLAUDE.md's
persistence invariant covers. Later transitions go through `persistCardTransition`,
which must also work with **no runner attached**, since the `expired` path starts no
turn.

Terminal states ride the same card as additional blocks rather than spawning sibling
types — the precedent SHI-258 set with `ChildMergedCard.deliveryFailure`.

Full at-rest contract: typed `PersistedMessage` field, column + migration,
`toRow`/`fromRow`, rehydrate in `loadSessionHistory`, `CARD_MESSAGE_FIELDS` +
`EVERY_OPTIONAL_FIELD_MESSAGE`, and the WS type in `TRANSCRIPT_SCOPED_MESSAGES`.
Store the `cardId` on the watch so the card can be repaired from watch state.

## Delivery dispatch

Per docs/240, `dispatch` takes a branded `PreparedDispatch` mintable only by
`prepareDispatch` or the queue converter, and returns a handle whose
`settled: Promise<TurnOutcome>` resolves once. Advance the watch on
`status === "completed"`; record the detail otherwise.

Two things to verify rather than assume — earlier drafts of this doc overstated what
neighbouring fixes guaranteed, three rounds running:

- `runner.enqueue` remains public and takes an **unbranded** `QueuedMessage`, so the
  brand constrains `dispatch`, not every route into the queue.
- `dispatchOnRunner` fire-and-forgets `runDispatchedTurn`, and the settlement's
  `finally` lives inside the agent's `done` handler — so a throw during setup (agent
  creation, attachment preparation) can leave the handle pending. Delivery must not
  assume a settlement always arrives.

## Out of scope

- **A general own-merge notification.** Every merged session getting a signal was
  considered and rejected: we cannot distinguish "finished" from "between PRs", and
  the notification pipeline is state-derived through `computeAttentionReason` — the
  same function driving the sidebar bar — so a merged reason there puts an amber
  needs-attention marker on every shipped session, permanently, in the group named
  "Recently resolved".
- **Any ShipIt-performed git mutation** on this path. That is the decision this
  design turns on.
- **Chaining.** The woken turn must not arm another self-watch; a server-side refusal
  while a watch is non-terminal, not prompt prose. One unattended turn per merge.

## Key files

| Area | File | Change |
|---|---|---|
| Watch state | `src/server/orchestrator/sessions.ts`, `shared/types/domain-types/session.ts` | Distinct `SelfMergeWatch` + column + migration; shared exhaustive pending predicate |
| Fire point | `src/server/orchestrator/app-lifecycle.ts` | Deliver after `markMergedAndPruneExcess`, with PR identity |
| PR identity | `src/server/orchestrator/pr-status-poller.ts` | Carry `{prNumber, headSha}` into the merge callback; fan closed outcomes to the expiry handler |
| Delivery | `src/server/orchestrator/merge-watch.ts`, `wake-session.ts` | Self branch in `buildWakeTurnPrompt`; reuse the SHI-258 supervisor |
| Poll gate | `src/server/orchestrator/polling-global-gate.ts` | Count pending self-watches |
| Arm surface | `src/server/session/agent-shim/shipit-session.ts`, `agent-ops-routes.ts`, session routes | `--self` + `--then-file`; arm/cancel routes with the refusal rules |
| Card | `chat-card-persistence.ts`, `chat-history.ts`, client card + handler | Arm card, runner-less transition, persistence contract |
| Agent docs | `src/server/shipit-docs/sessions.md` | Document `--self --then-file` and the one-turn rule |

## Testing

- Arm refusals: archived session, existing non-terminal watch, no branch, unparseable
  remote, inline `--then` rejected, empty/oversized instruction.
- Fires after the merge bookkeeping, not before (guards the remote-branch race).
- Closed-unmerged expires with **no** turn; the card records it.
- A superseded anchor PR does not retarget the instruction.
- Delivery failure retries on the SHI-258 backoff and terminates in `delivery-failed`.
- The wake-turn runs as a system turn behind a busy session and settles (asserting
  the docs/240 guarantees rather than re-proving them).
- The woken turn's attempt to re-arm is refused server-side.
- Card round-trip, no duplicate on replay, `expired` transition with no runner.
- Auto-merge path: a merge observed with no viewer and a reaped container still
  delivers.

## Resolved decisions

- **ShipIt performs no git work.** The rebase is the agent's ordinary work inside its
  own turn. This is the decision that removes the preparation lease, write-ahead reset
  staging, git-mutation coordinator, reset coordinator, consent policy, and `blocked`
  state from the design.
- **One path for manual and automatic merges**, with no ShipIt-side fast path —
  divergence costs more than the latency it would save.
- **Opt-in, armed explicitly, with the follow-up captured at arm time.** Most
  sessions are single-PR and then archived; an unconditional wake would tax every one
  of them.
- **`--then-file`, never inline** — the shim's existing rule about shell evaluation.
- **Fire after `markMergedAndPruneExcess`**, so the wake cannot race the remote-branch
  deletion.
- **Closed-without-merge expires and wakes nothing.**
- **Pin to the anchor PR; never retarget.**
- **Reuse docs/196's delivery and SHI-258's retry supervisor** rather than building a
  second of either.
- **No `completed-without-pr` state** — whether a PR resulted is the PR card's job.
- **One turn per merge; no chaining**, enforced server-side.

## Open questions

_None._

## History

Three cross-agent review rounds against earlier drafts (which had ShipIt performing
the branch reset before the turn) are what produced SHI-254, SHI-255, SHI-258,
SHI-259, SHI-260 and `docs/240-unlosable-turn-dispatch`. Those fixes stand on their
own and are prerequisites no longer: the delivery path they repaired is the one this
design reuses.

The reviews' recurring finding — that the design had become platform work — was
correct about the draft and is resolved by the "no ShipIt git work" decision rather
than by narrowing the feature. The autonomy the feature was for is intact; what went
away was an implementation choice.
