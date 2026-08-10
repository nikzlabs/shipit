---
issue: planning#255
title: Self-merge wake — continue a session automatically when its own PR merges
description: A session opts in to being woken when its own PR merges; the agent resets its branch via an explicit command and continues, inside its own turn.
---

# Self-merge wake (`shipit session notify-on-merge --self`)

## Problem

docs/196 wakes a **parent** session when a **child's** PR merges. Nothing wakes a
session when its **own** PR merges.

For a session that ships several PRs in a row that is the missing half. The user says
"do A, then B, then C", A's PR opens, and the chain stops: the merge happens later —
by hand from ShipIt, by hand from GitHub, or via auto-merge once CI goes green — and
work only resumes when someone notices. Today's merge path deliberately quiets the
session, because it assumes **1 session = 1 PR = done**. Right for most sessions,
wrong for the ones that continue.

## What this is

**The existing merge-watch, pointed back at the same session.** Not a new subsystem.

Manual verification can use a documentation-only PR from the session being
watched: open the PR, run `shipit session notify-on-merge --self`, and merge it.
The resulting wake turn must begin with the guarded `shipit branch reset-to-base`
flow before any follow-on work starts.

The explicit reset also completes docs/218's user-facing state transition. On
success it immediately clears `reset_eligible` (hiding the composer control),
re-arms the merged PR lifecycle to its clean ready state, and emits the same
persisted `BranchUpdatedCard` used by the checked composer flow. The reset route
captures the merged PR snapshot before re-arming so the durable card retains the
correct PR number and concrete before/after SHAs.

```
shipit session notify-on-merge --self        (agent arms it when work remains)
  → store a self-watch on the existing merge_watch row, anchored to the open PR
  → (the PR merges — by hand or by auto-merge; the source is irrelevant)
  → poller detects it → merge bookkeeping completes
  → deliver a wake-turn over docs/196's existing path
       "PR #N merged. Run `shipit branch reset-to-base` first, then continue the
        work you were asked for. Re-arm if more remains."
  → the agent resets, continues, and re-arms if the plan has further steps
```

## Requirement provenance

Separating what was decided from what was derived or proposed.

### Decided (user)

| Requirement | What was said |
|---|---|
| The goal: **ship multiple PRs in a row from one session, automatically** | "sometimes I use a single session with multiple PRs in a row, and this would be quite helpful" |
| **Opt-in via a command the agent invokes** | "The agent would need to invoke a special command to get notified to merge. Because most of the sessions are single PR and then they are archived." |
| **Reuse the child-message delivery** | "We reuse the child message functionality and let the agent know that its PR was merged" |
| **No destructive git behind the agent's back** | "ShipIt would not do any destructive work… instead, it would be the agent doing its regular work" — clarified to "nothing unbidden" once it emerged that the command relays to the orchestrator, which executes the reset |
| **One path for manual and automatic merges** | "I don't want any divergence" |
| **Closed-without-merge drops the intent with a note, no wake** | Chosen from options |
| **Arming surfaces a cancellable card** | Chosen from options |
| **Chaining, implemented at the agent level** | "Can we simply implement chaining on the agent level?… the agent would need to rearm manually" |
| **A tested command rather than prompt instructions** | "the command sounds more robust" |
| **planning#264 fixed first, separately** | Chosen from options |

### Derived — implementation constraints, not requirements

The reset safety gate; `merge-observed`, the retry supervisor and startup reconcile
(inherited from docs/196, not built); firing after `markMergedAndPruneExcess`; the live
open-PR lookup; arming replacing an existing watch; explicit-mode bypass of docs/218's
preference; `handWorkspaceBackToWorker`; the co-located prompt file and card persistence
(repo-wide rules); planning#264 as a prerequisite.

### Easily-misread boundaries

- **Opt-in means opt-in via a command** — nothing about capturing the follow-up as a
  payload, which is why there isn't one.
- **The invariant is not "nothing happens outside a turn"**, which would be impossible:
  poll observation, card delivery and scheduling the wake all happen outside a turn. It
  is narrower — **no destructive branch mutation occurs unless the agent invokes the reset
  command during its turn.**
- **Chaining does not imply plan *persistence*** — only agent-level re-arming while the
  conversation still contains the work.

## Storage — reuse, don't parallel-build

Extend `SessionMergeWatch` with an optional `{ kind: "self", watchId, prNumber }` and set
`parentSessionId === sessionId`. No new column, no migration, no second list query, no
parallel manager path — and `merge-observed`, the planning#260 retry supervisor, the polling
gate and `reconcilePending` all come by inheritance rather than reimplementation.

**Accepted limitation:** a session cannot be simultaneously parent-watched and
self-watching, because the row holds one watch. Refuse a self-arm when it holds a genuine
parent→child watch. A session that is simultaneously watched by its parent and watching
itself is rare enough that a second subsystem costs more than the collision does.

Nothing else is copied into the watch: `mergedHeadSha` already lives on the session, and
the delivery fields belong to docs/196's machinery.

## Arming

`shipit session notify-on-merge --self` — no payload.

**There is no captured follow-up.** The session's own transcript already contains the
plan, exactly as docs/196 relies on the parent's history. The wake prompt says "continue
the work you were asked for"; if that is genuinely ambiguous the agent can stop and ask.
Cutting the payload also removes inline-flag rejection, stdin handling, duplicated
validation, and the "captured follow-up" card copy.

Resolve the PR with a **live open-PR lookup** (`findPullRequest`) and store its number.
The snapshot cannot be used: at a chain boundary the agent arms seconds after opening the
next PR, while the session still sits in `mergedSessions` — which the poller skips — so
`pr_status` still describes the *previous, just-merged* PR, and `gh pr create` returns
before awaiting its own refresh.

**One refusal: no open PR for the current branch.** Archived is impossible (the agent is
executing in that session); no branch and an unparseable remote both fail the lookup on
their own. If the PR has *already merged*, the lookup finds nothing and says so — the
agent simply continues in its current turn. That removes the contradictory "an open PR is
required, but an already-merged one fires immediately" branch.

**Arming always replaces** any existing self-watch, including one already delivering.
Without that the wake turn could never re-arm: the watch stays `merge-observed` for the
whole turn.

## Delivery

**Fire from `onMergeDetectedCb`, after `markMergedAndPruneExcess` resolves.** Earlier —
from `onPrTerminalState` — races the remote-branch deletion, so the agent could reset and
push a branch about to be deleted. Read the PR facts from the persisted snapshot at fire
time; `setPrStatus` and `setMergedHeadSha` both run *before* this callback, so the
sessionId-only signature needs no widening.

**Compare the merged PR number to the anchor.** A mismatch means a docs/202 re-arm
replaced the work before the merge landed — append a note and clear the watch rather than
waking on an unrelated PR. This replaces both a `superseded` state and an eager hook in
`pr-rearm.ts`; one comparison at fire time covers them.

**Closed-without-merge**, from `onPrTerminalState` (the merge callback never fires for
it): append a persisted note, clear the watch, start no turn.

**`watchId` is checked on asynchronous settlement.** Not full compare-and-set — one
expected-identity check, and it is load-bearing: the next watch is armed *before* the old
wake turn settles, so without it an old settlement marks the new watch delivered.

Delivery, retry and restart recovery are docs/196's, unchanged; `reconcilePending`
branches on `kind`.

### One merge, one wake — even when the wake turn is cut short (planning#318)

In production a single merge produced **two** identical wake turns 7.5 minutes apart.
The wake ran, the user interrupted it, and the session's next message spawned a fresh
agent that took the runner's `_agent` slot. The wake spawn's late `agent_done` then
arrived with a stale `runToken` and was dropped by the docs/146 relay guard — right for
the relay, since emitting it would run the dead turn's teardown against the live turn's
slot — but nothing else told the wake turn it was over. Its settlement stayed pending,
so the watch sat at `merge-observed`, which the planning#260 supervisor cannot distinguish
from "the container never booted". Neither `settleAsDropped` net covered it: the runner
was alive (no `disposed`) and the worker truthfully reported an agent running (no
`turn_abandoned`).

Three changes, each closing one link of that chain:

- **Displacement settles the superseded turn.** When a new spawn takes a runner's agent
  slot from a proxy that never reached a terminal event, the runner emits `superseded`
  on the displaced proxy and `executeAgentTurn` settles — **settlement only**. No
  `setAgent(null)`, no drain, no finished-SSE, no post-turn commit: the turn that
  displaced this one owns the runner and the working tree, and its own `git add -A`
  sweeps the tree. The docs/146 relay guard itself is untouched.
- **`interrupted` is a distinct outcome.** A turn that ran and was cut short — the user
  pressed stop, the orchestrator interrupted the CLI for an AskUserQuestion / plan
  approval, or a newer turn took the slot — no longer settles as `no-result`. The two
  are indistinguishable from inside the executor (no `agent_result` ever arrived) but
  mean opposite things to a delivery supervisor: `no-result` is "nobody saw it, try
  again"; `interrupted` is "the prompt reached a live agent and a human stopped it".
  `buildDeliverySettlement` therefore treats `interrupted` as **terminal** (`delivered`),
  because re-sending a notification the human already read is a duplicate, not a
  recovery. `no-result` / `errored` / `dropped` stay retryable.
- **The retry asks ground truth before dispatching.** `dispatch` queues politely while
  `runner.running` is true, but that flag is a local mirror; when it is stale-false the
  retry takes the start-now branch and a system turn's spawn boundary
  (`dispatched-turn.ts`'s `systemTurn && !reuse`) **kills the resident process**. The
  supervisor is the one dispatcher with no human in the loop, so it now reads the
  worker's `turnActive` via `runner.hasTurnInFlight()` and defers a tick when a turn is
  genuinely in flight. Fails open — an unreachable worker is the failure the retry
  exists for.

**Follow-up, 2026-08-10 — retirement is displacement too.** The same duplicate wake
recurred (session 18d04568, PR #2104 sent twice three minutes apart) through a route the
first bullet does not cover. `supersedeDisplacedAgent` fires on a slot **replacement** —
`setAgent(next)` over a still-installed proxy. Both retirement blocks in
`runDispatchedTurn`'s `runOnce` take the other shape, `kill(); setAgent(null);
createAgent()`, so the incoming proxy is installed over an already-empty slot and the
hook has nothing to compare against. Wake A had produced its `agent_result` and its
post-turn drain started wake B; B is a system turn, so it declined to adopt A's resident
process and retired it here; A's own `agent_done` was then dropped by the docs/146
stale-spawn guard, and A never settled at all.

So the rule is **retirement is displacement**, and it holds at every site that retires a
resident process to start a turn on the same runner: both blocks in `runOnce`
(`supersedeRetiredTurn`), the two `resident-spawn-guard.ts` helpers a drained turn and
the WS path share, and the WS failover release in `agent-execution.ts`. Each settles the
outgoing turn before killing — and, where the site drops the previous turn's listeners,
before that too, since the settlement travels on one of them. Settlement only, same
contract as the displacement hook; the outcome is `completed` when the retired turn's
result had arrived, `interrupted` when it had not, and never `no-result`, which is the
one the supervisor retries.

Two same-shaped sites are deliberately **not** covered, because each has a real terminal
event of its own: `send-message.ts`'s stale kill leaves the slot installed, so the next
`setAgent` is an ordinary replacement the displacement hook already sees, and the
`answer_question` kill follows an interrupt whose `done` does arrive (that is the
`wasInterrupted` shape planning#318 already pinned).

The wider `systemTurn && !reuse` preemption is **not** fixed here: its comment ("only
reachable with no turn in flight — `dispatchOnRunner` enqueues while `running`") is
accurate as far as the flag goes, and every other system-turn dispatcher (rebase
resolution, CI auto-fix) is user-initiated with a human watching. Gating the timer-driven
path was the smaller, verifiable change.

The wake prompt stays terse: it names the merged PR, gives the guarded reset
command and failure rule, then says how to continue and re-arm. The transcript
and persisted lifecycle card already hold the surrounding context and PR URL.

**Workspace:** call the existing `restoreSessionWorkspace` helper in
`wakeSessionWithTurn` when the checkout is missing — one line, and it closes the same
latent gap for docs/196. Preferred over exempting pending watches from disk reclaim,
which would hold disk for the unbounded duration of human review.

## The reset command

`shipit branch reset-to-base` — an **explicit mode over the existing docs/218 reset
core**, not a new service. Reuse its gate, fetch, re-gate, reset and live-tip leased push.

Six things the mode must change or add:

- **Ignore `getAutoResetMergedBranch()`.** A command the agent deliberately invoked must
  not silently no-op because an unrelated composer preference is off.
- **Idempotent.** Clean tree and already at the base tip → exit 0, "proceed". After any
  successful reset `HEAD ≠ mergedHeadSha`, so without this a duplicate wake, a retry, or a
  second invocation would refuse and stop a chain whose branch state is perfect. Check
  already-at-base **before** the `mergedHeadSha` gate, since a docs/218 reset clears it.
- **Report force-push failure as failure.** The current heal is best-effort and still
  returns success; in a chain that means every later push against the diverged remote is
  silently dropped and the next PR never updates.
- **`handWorkspaceBackToWorker` in a `finally`.** The orchestrator writes as root; without
  it the agent hits `EACCES` on its first edit — inside the very turn the wake enables.
- **Derive the base durably, not from the live PR snapshot alone.** `getPrStatus` is
  transient: docs/202's `PrStatusPoller.reArm` nulls it every time a merged session gains
  new work, which is the ordinary "keep working after a merge" path. Reading the base only
  from there made a routine merge → commit → re-arm sequence refuse with "no merged pull
  request recorded" — wrong (the base never changed) and misleading (a PR had very much
  merged). Fall back to `session.previousMergedPr.baseBranch`, which both re-arm paths
  write via `clearMerged` in the same beat the snapshot is cleared and which is DB-backed.
  No third fallback to the repo **default** branch, even though one is knowable (session
  branches are cut from `origin/<defaultBranch>`). It would not let a never-PR'd session
  reset — the gate independently requires `mergedAt` + `mergedHeadSha` + a live `prStatus`,
  so such a session refuses regardless of which base is found — and all it would add is a
  guessable reset target in a command whose safety story is "reset only onto the base of a
  PR this branch provably shipped". Widening *which* sessions may reset is a separate
  decision about the gate, not something to smuggle in via the base lookup; the no-PR
  refusal therefore names the gate as the reason rather than a missing base.
  `resolveResetBase` in `services/pre-turn-reset.ts`.
- **Simple CLI semantics:** exit 0 for reset/already-at-base, nonzero with a reason
  otherwise. The agent behaves identically for "unsafe" and "errored", so they are one
  outcome.

The safety gate is retained exactly: `HEAD === mergedHeadSha`, clean tree, on
`session.branch`, no in-progress sequencer, re-checked after the fetch. It is what makes a
duplicate wake, a late wake, or a wake behind planning#264's uncommitted work refuse rather
than destroy.

**The gate is prompt-mediated.** A refused agent could still hand-roll `git reset --hard`.
The refusal message is therefore load-bearing copy — it must say why and forbid working
around it — and extending the existing PreToolUse hook to bare destructive git is worth
considering.

## Chaining

Agent-level. One watch, armed repeatedly: the agent arms for the current PR and re-arms
after opening the next. **ShipIt models no chain** — no chain object, revisions, staged
links or cancellation tombstone.

Cancel is therefore correct rather than aspirational: cancelling the armed watch means no
wake fires, so no turn runs, so nothing re-arms. A turn already in flight finishes and may
re-arm; the card copy should say so rather than implying otherwise.

A refused reset ends the chain naturally — the agent reports and does not re-arm.

Every link requires a real merge (a human click, or CI passing on a PR that human opened),
so nothing runs unprompted. The residual risk is staleness with auto-merge on, mitigated
by the prompt's "unless the user has since redirected you".

## Cards

- **Arm:** a persisted, cancellable card via `emitChatCard` (the arm happens mid-turn, an
  agent tool call — the side-channel shape CLAUDE.md's persistence invariant covers).
  Cancel carries `watchId` so a stale card cannot cancel the next PR's watch.
- **Closed-without-merge, anchor mismatch, delivery failure:** append a plain persisted
  note.
- **Merged:** no card — the wake turn itself is the visible signal.

No terminal-state card family, no in-place transitions, no runner-less
`persistCardTransition`, no card repair, no archive-time transition. Archiving clears the
watch silently; the user froze that transcript deliberately.

## Prerequisite — done

**planning#264** ✅ — the finished turn's local commit now completes before a queued turn
starts. Without it a wake queued behind a user turn would meet uncommitted work and
refuse, making the happy path unreliable. The guarantee lives inside `tryDrain`, the
funnel every drain site passes through, so it holds for all of them rather than for one
reordered call site.

## Known gaps (tracked separately)

- **planning#265** — a dispatch throwing during setup strands its settlement and blocks
  planning#260's retry.
- ~~**planning#266** — a restart mid-wake can queue a duplicate; the reset gate makes it refuse
  rather than destroy.~~ Closed: every wake-turn now carries a durable delivery id the
  worker reports back, so adoption re-settles the surviving turn and reconcile
  redispatches only when nothing reports it. See docs/240 § Fix C.

## Key files

| Area | File | Change |
|---|---|---|
| Watch | `sessions.ts`, `shared/types/domain-types/session.ts` | `kind`/`watchId`/`prNumber` on `SessionMergeWatch` |
| Arm / cancel | `agent-shim/shipit-session.ts`, `agent-ops-routes.ts`, session routes | `--self`; live open-PR lookup; cancel with `watchId` |
| Delivery | `merge-watch.ts` | Self branch: anchor comparison, closed-note, `watchId` settlement check, `reconcilePending` branch; planning#318 `interrupted` is terminal + the retry's `hasTurnInFlight` gate |
| Settlement | `turn-settlement.ts`, `turn-executor.ts` | planning#318 `interrupted` outcome; settle on the `superseded` event |
| Slot displacement | `container-session-runner.ts`, `session-runner.ts`, `proxy-agent-process.ts` | planning#318 emit `superseded` on a proxy pushed out by a newer spawn |
| Slot retirement | `dispatched-turn.ts`, `resident-spawn-guard.ts`, `ws-handlers/agent-execution.ts` | planning#318 follow-up: settle the outgoing turn at every site that retires a resident process by CLEARING the slot, which bypasses the displacement hook |
| Wake | `wake-session.ts` | Restore the checkout if missing |
| Reset | `services/pre-turn-reset.ts` | Explicit mode: setting-blind, idempotent, strict push failure, ownership handback |
| Prompt | `orchestrator/prompts/self-merge-wake.md` | Co-located template |
| Card | client card + handler | Arm card with Cancel |
| Agent docs | `shipit-docs/sessions.md` | `--self`, re-arming, the reset command |

## Testing

One test each, not a matrix:

- Arm: no open PR refuses; a live lookup immediately after `gh pr create` anchors to the
  **new** PR, not the stale snapshot.
- Card: the arm card persists and round-trips; Cancel with a stale `watchId` does not
  cancel a newer watch.
- Delivery: fires after merge bookkeeping; anchor mismatch appends a note and wakes
  nothing; closed-without-merge appends a note and wakes nothing; an old settlement does
  not mark a newly-armed watch delivered.
- Eviction: a wake against a missing checkout restores it.
- Reset command: refuses on dirty tree / moved HEAD / detached / sequencer; a second
  invocation returns already-at-base; it runs with the docs/218 setting off; force-push
  failure is not success; the agent can edit files afterwards.

## Resolved decisions

- **Reuse the existing merge-watch with `kind: "self"`** — no parallel subsystem. Accepted
  limitation: no simultaneous parent-watch and self-watch on one session.
- **No captured follow-up payload.** The transcript already holds the plan.
- **Live open-PR lookup at arm time**, one refusal, no `checkAndFireNow` branch.
- **Arming always replaces**, including a delivering watch.
- **Explicit mode over the existing reset core**, not a new service; setting-blind,
  idempotent, strict about push failure, hands the workspace back.
- **Chaining is agent-level**; ShipIt models no chain.
- **Notes, not a card lifecycle**, for terminal outcomes.
- **No docs/218 `resetEligible` suppression** — the idempotent command already resolves the
  overlap, and suppressing would leave a user's own next turn on the stale merged tip.
- **No eviction exemption** — restore at delivery instead.
- **One expected-`watchId` check on settlement**, not full CAS.
