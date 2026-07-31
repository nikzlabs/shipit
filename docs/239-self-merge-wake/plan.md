---
issue: https://linear.app/shipit-ai/issue/SHI-253
title: Self-merge wake — continue a session automatically when its own PR merges
description: A session opts in to being woken when its own PR merges; the agent rebases and continues inside its own turn via a tested reset command. Nothing happens unbidden or outside a turn.
---

# Self-merge wake (`shipit session notify-on-merge --self`)

## Problem

docs/196 wakes a **parent** session when a **child's** PR merges. Nothing wakes a
session when its **own** PR merges.

For a session that ships several PRs in a row that is the missing half. The user says
"do A, then B, then C", A's PR opens, and the chain stops: the merge happens later —
by hand from ShipIt, by hand from GitHub, or via auto-merge once CI goes green — and
work only resumes when someone notices. Today's merge path deliberately **quiets**
the session (`markMergedAndPruneExcess` marks it merged and deletes the remote head
branch; the sidebar sinks it into "Recently resolved"; `useAttentionInfo` suppresses
the attention bar), because the whole path assumes **1 session = 1 PR = done**. Right
for most sessions, wrong for the ones that continue.

## Requirement provenance

Where each requirement came from, so the ones that were decided can be told apart from
the ones that were inferred.

### Decided explicitly (user)

| Requirement | What was said |
|---|---|
| The motivating case is **several PRs in a row from one session** | "sometimes I use a single session with multiple PRs in a row, and this would be quite helpful" |
| **Opt-in with stated intent**, not a general merge notification | Rejected the notification framing ("I don't use notifications, only the sound"), and chose the armed-intent option instead |
| **Opt-in is armed by the agent invoking a command** | "The agent would need to invoke a special command to get notified to merge. Because most of the sessions are single PR and then they are archived." |
| **Reuse the child-message functionality** for delivery | "We reuse the child message functionality and let the agent know that its PR was merged" |
| **Nothing unbidden**: no destructive git work on ShipIt's own schedule, behind the agent's back, outside a turn | "we don't do any git work… ShipIt would not do any destructive work… instead, it would be the agent doing its regular work" — clarified when review showed the command relays to the orchestrator, which executes the reset: "Nothing unbidden — the current design is fine" |
| **One path for manual and automatic merges — no divergence** | "manual or automatic merges from GitHub, they would all work in the same way. I don't want any divergence." |
| **Closed-without-merge drops the intent with a note, no wake-turn** | Chosen from options |
| **Arming surfaces a cancellable card** | Chosen from options |
| **Chaining until the plan runs out** | Chosen from options — *this reverses an earlier "one turn, one PR" choice, made before the trade-off was clear* |
| **Chaining is implemented at the agent level** — the agent arms for the current PR and re-arms after creating the next; ShipIt models no chain | "Can we simply implement chaining on the agent level?… the agent would need to rearm manually. Then the agent would be able to merge as many PRs as it wants without any special work on ShipIt itself." Replaced a durable chain object that two reviews found broken on its own happy path. |
| **SHI-262 is fixed first, on its own** | Chosen from options |
| The rebase runs via a **tested command** the agent invokes, not prompt instructions | Raised as a deviation from "the instructions would tell the agent to rebase" and confirmed: "I'm fine either way. And actually, the command sounds more robust." |

### Derived from review against source

Found by cross-agent review, each traceable to a verified fact in the codebase rather
than to a preference: the `merge-observed` state (the retry supervisor filters on it);
the startup reconcile (`alreadyTerminal` suppresses the callback after a crash); arm-time
anchoring and requiring an open PR (binding "on first observation" would anchor to an
unrelated PR); `checkAndFireNow` for an already-merged PR; suppressing docs/218's
`resetEligible` (two reset mechanisms otherwise armed at once); the supervisor keyed by
workspace restore before dispatch; the prompt as a co-located `.md`; the live PR lookup at arm time (the
snapshot is stale by construction at a link boundary); arming replacing a `merge-observed`
watch (otherwise the wake turn can never re-arm); the reset command being a distinct
service rather than the interactive policy wrapper, and idempotent; and the invariant
restated as "never unbidden, never outside a turn" after the earlier headlines proved
literally false.

### Proposed (mine — not confirmed)

`--then-file` rather than an inline flag; firing after `markMergedAndPruneExcess`;
omitting a `completed-without-pr` state; carrying the remaining plan in each re-arm's
follow-up text; treating archive-after-arm as a visible card transition; and stating
Cancel's honest limit (it stops the next wake, not a turn already running).

*(No open deviations. The command-vs-instructions change was raised as one and has since
been confirmed — see the table above.)*

## Shape — a message plus a tested command

**Nothing happens unbidden or outside a turn.** The wake is a message; the rebase runs
because the agent chose to run it, during its turn, visibly. The agent invokes a **tested
command** rather than reconstructing git plumbing from prose.

```
shipit session notify-on-merge --self --then-file -    (armed only when a follow-up was stated)
  → persist the armed watch, anchored to the open PR + surface it in the transcript
  → (the PR merges — by hand or by auto-merge; the source is irrelevant)
  → poller detects it → merge bookkeeping completes → watch → merge-observed
  → deliver a wake-turn over docs/196's existing path
       "PR #N merged into <base>. Run `shipit branch reset-to-base` first, then: <follow-up>."
  → the agent runs that command, then the follow-up, inside one turn
  → if the plan has further steps, the agent re-arms for the next one
```

### Why the command, not just instructions

An earlier draft had the wake prompt tell the agent to "reset to the latest base and
force-push with lease". Two reviews independently found that unsafe, and the codebase
contains the refutation: `git.ts` documents that a bare `--force-with-lease` "pins the
lease to the local remote-tracking ref", which a session clone never prunes — so the
tested `forcePush` reads the live remote tip via `ls-remote` first. After
`markMergedAndPruneExcess` deletes the remote branch, the naive form is **rejected on
the first try in the mainline case**, and the realistic agent response to that
rejection is to escalate to plain `--force`, discarding the lease entirely.

docs/218 exists because this operation is error-prone enough to automate. Asking the
agent to re-derive base selection, lease semantics, and the deleted-branch case from a
prompt loses that bet again.

**`shipit branch reset-to-base`** reuses the existing `pre-turn-reset` *safety and git*
logic — the same gate, fetch, re-gate, reset, force-push-with-live-lease — invoked by the
agent, inside its turn.

**The invariant is "never unbidden, never outside a turn" — not "ShipIt's process runs no
git".** The command relays to the orchestrator, which executes the reset, as every agent
op does. That is deliberate and confirmed: the objection was to ShipIt reaching into the
repo on its own schedule behind the agent's back, which this does not do. Earlier drafts
said "ShipIt performs no git work" and then "does not mutate the session branch"; both
were literally false (`markMergedAndPruneExcess` deletes the remote branch, the wake's own
post-turn flow commits and pushes, and this command resets).

### The existing helper is not a usable command contract

`autoResetMergedBranchOnContinue` is an interactive *policy wrapper*, not a reusable
operation. Reusing it as-is would break the feature in six ways:

- It honours `getAutoResetMergedBranch()`, so an explicit command would silently no-op for
  anyone who turned interactive auto-reset off.
- Gate refusal, disabled setting, and thrown errors all collapse to `moved: false`, which
  cannot support "refuse and report *why*".
- It returns `moved: true` even when the force-push fails, so a chain would continue onto
  a branch whose remote is diverged — later auto-pushes then drop silently.
- It does **not** perform the docs/216 session/poller re-arm or the PR-card update; its
  current caller does that separately in `agent-execution.ts`. Without it the session
  stays in `mergedSessions`, the poller keeps skipping it, and `pr_status` never refreshes
  — which is also what makes the next link's anchoring fail.
- The orchestrator runs as **root**, and a hard reset rewrites `.git` and worktree files.
  The repo requires `handWorkspaceBackToWorker` after such an operation; without it the
  UID-1000 agent hits `EACCES` on its first follow-up edit — the command would break the
  very turn it exists to enable.
- It takes no workspace lock, though it now runs *during* an active turn alongside the
  post-turn commit path that does.

So: extract a typed `resetMergedBranchToBase` service — safety gate only (no UI
preference), `withWorkspaceLock`, distinct `reset | already-at-base | refused(reason) |
error` outcomes, the session/poller re-arm, and a `finally` that always hands the
workspace back.

**It must be idempotent.** After any successful reset `HEAD = origin/<base> ≠
mergedHeadSha`, so a re-delivered wake, an SHI-258 retry of a turn that failed *after* the
reset, or a double invocation would all refuse even though the branch state is perfect —
and a refusal tells the agent to stop. Clean tree ∧ already at the base tip →
`already-at-base`, exit 0, "proceed". That one outcome defuses the duplicate-wake case,
the retry case, and double invocation.

### The safety gate is load-bearing for three separate hazards

The command inherits docs/218's gate — **`HEAD === mergedHeadSha`, clean tree, on
`session.branch`, no in-progress sequencer** — and fails closed. That single check is
what makes three otherwise-serious failures survivable:

| Hazard | Without the gate | With it |
|---|---|---|
| Queue drains before the previous turn's commit (SHI-262) | `reset --hard` destroys uncommitted edits, unrecoverably | Dirty tree → refuse and report |
| A turn advanced the branch between GitHub merge and poll detection | Resets away unmerged work | `HEAD ≠ mergedHeadSha` → refuse |
| Restart duplicates a wake (no durable delivery identity) | The second wake resets away what the first produced | `HEAD ≠ mergedHeadSha` → refuse |

None of these are *fixed* by the gate — they are converted from data loss into a
visible no-op. SHI-262 is being fixed on its own; the other two are documented under
*Known gaps* below.

### One path for every merge

Manual-from-ShipIt, manual-from-GitHub, and auto-merge are **not** distinguished.
`verifyMissingPr` observes a merged PR identically in all three, so a single path costs
nothing and avoids two behaviours to test. Treating a ShipIt-side merge as a direct
trigger was considered and rejected: it buys latency at the cost of divergence.

Auto-merge (`auto-merge-manager.ts`, a per-session opt-in, used in practice) means the
merge really can land with nobody watching, so delivery must survive an idle-reaped
container, an evicted workspace, and an orchestrator restart.

## Opt-in, always

Armed only when the user has stated a follow-up, by the agent, explicitly. Never
implied by the existence of a PR.

Most sessions are single-PR and then archived. An unconditional wake would give every
finished session a turn that reads "your PR merged", concludes there is nothing to do,
and leaves a wasted turn and a noisy transcript behind.

### Arm surface

`shipit session notify-on-merge --self --then-file -`

`--then-file` (with `-` for stdin), **not** an inline `--then`: the shim already
rejects inline prompts because the shell evaluates backticks, `$(…)`, and quotes first
— the same reason `gh pr create` takes `--body-file -`. Validate non-empty and bounded
length in shim and orchestrator; require exactly one of `<child-id>` or `--self`.

**Refuse to arm** when the session is archived; has no branch or no parseable GitHub
remote (the watch could never be polled, while still holding the polling gate open);
or **has no currently-open PR** — see anchoring below.

**If the PR has already merged at arm time**, fire immediately rather than arming:
the poller will not re-observe an already-terminal PR, so the watch would sit armed
forever. docs/196 solves this with `checkAndFireNow`; reuse it.

**Arming always replaces any existing watch** — whether `armed` (the user said "actually,
do Y instead") or `merge-observed` (the wake turn arming the next link). There is no
"refuse while non-terminal" rule; that rule made chaining impossible, since the watch is
`merge-observed` for the entire wake turn.

## Chaining — at the agent level, with no chain in ShipIt

A multi-step plan chains, and **ShipIt models no chain at all.** There is one watch,
armed repeatedly: the agent arms for the current PR, and when the wake turn opens the
next PR it arms again. Nothing persists a plan, a link sequence, or a position within
one.

An earlier draft specified a durable chain object with revisions, staged links promoted
on clean settlement, and a cancellation tombstone. Two reviews found it broken on its
own happy path, and all of that machinery existed only to track something ShipIt has no
reason to know. Deleted.

**The remaining plan persists anyway, in the thing already being persisted.** Each
re-arm carries the *remaining* steps as its follow-up text: state "A, then B, then C"
and the second watch's instruction is "do B, then C", the third's is "do C". No parallel
structure to keep consistent with the transcript.

**Cancel becomes correct rather than aspirational.** Cancelling the armed watch means no
wake fires, so no turn runs, so nothing re-arms — the chain stops because the wake is its
only engine. A wake turn already in flight will still finish and may re-arm at the end;
the chat-native answer applies there (message the session), and the card copy should say
so rather than implying Cancel retracts a running turn.

Two rules make this work:

- **A new arm during `merge-observed` replaces the delivering watch.** Without this the
  agent can never re-arm: the watch stays `merge-observed` for the whole wake turn and
  only settles afterwards, so an "arm refused while non-terminal" rule leaves no moment
  when re-arming is legal. Replacement is itself the old link's terminal event, and the
  new watch anchors to a different PR, so nothing can re-fire the old one.
- **Arming resolves the PR live**, not from `pr_status` — see *Anchoring*.

The runaway risk stays bounded by construction: **every link requires a real merge** — a
human click, or CI passing on a PR that human opened. Nothing runs unprompted. The
residual risk is staleness with auto-merge on, mitigated by the wake prompt's escape
clause (*proceed unless the user has since redirected you*, shared with docs/196) and by
each re-arm restating the remaining plan in the transcript.

**A refused reset ends the chain naturally**: the agent reports and does not re-arm, so
nothing further fires and the user sees why.

## Delivery

**Fire from `onMergeDetectedCb`, after `markMergedAndPruneExcess` resolves** — not from
docs/196's `onPrTerminalState` hook, which is launched *before* `setMergedHeadSha` and
before the merge bookkeeping, all fire-and-forget. Waking there would race the
remote-branch deletion and have the agent push a branch about to be deleted. Fire
immediately after that await, before the unrelated `emitResetEligibleSignal` work, so
an unrelated failure cannot skip delivery.

**Closed-without-merge expires the watch and wakes nothing.** `onMergeDetectedCb` only
fires for merged outcomes, so this must fan out from `onPrTerminalState` — safe there
because it starts no turn. The work did not ship, so the follow-up's precondition is
false.

**States: `armed → merge-observed → delivered`**, with terminal `expired`, `cancelled`,
and `delivery-failed`. The intermediate state is **not optional**: the
SHI-258 retry supervisor filters on `merge-observed`, its arm/stop conditions use it,
and `reconcilePending`'s recoverable set is armed-or-observed. An earlier draft
specified `armed → delivered` while claiming to reuse that machinery — it would have
had nothing to key on.

**Startup reconcile is required and does not exist for self-watches.** `verifyMissingPr`
persists the terminal PR snapshot **before** launching the callbacks, and
`alreadyTerminal` is derived from that persisted state — so a crash between snapshot and
delivery means the merge callback **never fires again**. docs/196's restart backstop is
`reconcilePending`, whose sole call site is bootstrap and which feeds every result to
the *child* handler. A self-watch equivalent must re-derive "PR terminal + self-watch
non-terminal → deliver" from the persisted snapshot. The same applies to the
closed→`expired` fan-out, which sits behind the same guard.

**All transitions go through the watch manager — a single writer** — and each checks the
current state before writing, so a late merge callback or settlement cannot resurrect a
cancelled or replaced watch. Full compare-and-set on every transition was specified in an
earlier draft and cut: one watch per session, mutated from one place, does not have the
contention that would justify it.

**Delivery failures reuse SHI-258's supervisor** unchanged.

## Anchoring

Bind the watch to a PR **at arm time**, resolved by a **live lookup**
(`findPullRequestAnyState` — the same source `verifyMissingPr` trusts), **not** from the
persisted `pr_status` snapshot. An open PR is required to arm; binding "on first
observation" was incoherent, since with no PR at arm time a later unrelated PR would
become the anchor — exactly the retargeting this prevents.

The live lookup is load-bearing for chaining, not a refinement. At a link boundary the
agent arms seconds after opening the next PR, while the session still sits in
`mergedSessions` — which the poller skips — so `pr_status` still describes the
*just-merged previous* PR, and `gh pr create` returns before awaiting its own refresh.
Reading the snapshot would either see no open PR and refuse (killing the chain at every
link) or anchor to the old merged PR and fire a spurious wake immediately.

Identity is the **PR number**. The head SHA is *not* identity — ordinary CI and review
pushes move it on the same PR — but the **terminal PR head SHA** is captured at merge
as the reset command's safety anchor (`mergedHeadSha`). Two different things; the
earlier draft conflated them into an "immutable pair".

If the merged PR does not match the anchor — a docs/202 re-arm replaced the work before
the merge landed — **drop the watch and leave a note**. The instruction was captured for
work that no longer exists, so it must not transfer to an unrelated PR. An earlier draft
gave this its own `superseded` terminal state; storing the anchor PR number and comparing
it achieves the same protection without one.

## Coexistence with docs/218

After the merge, **two** reset mechanisms are armed on the same session: docs/218's
interactive pre-turn reset (default on, with its composer control) and this wake. If
the user sends a message before the wake runs, ShipIt resets the branch, and the wake
prompt's factual claims are then stale.

So: an armed or in-flight self-watch **suppresses `resetEligible`**, and the wake prompt
is built from state read at *delivery* time, not merge time. One affordance for one
action.

## The wake prompt

A co-located `.md` template loaded via `loadPrompt` at module top level, per CLAUDE.md's
prompts rule — not inline TypeScript. It carries the PR number, base branch, terminal
head SHA, the captured follow-up, and the remaining plan. It instructs the agent to run
`shipit branch reset-to-base` **first**, to stop and report if that command refuses
rather than working around it, and not to re-apply shipped work.

## Storage

A distinct `SelfMergeWatch` in its own column, carrying `watchId`, the anchor PR number,
`mergedHeadSha`, `followUp`, the remaining plan, `cardId`, and the SHI-258 delivery
record (attempts, lastAttemptAt, lastError). docs/196's `SessionMergeWatch` structurally
requires `parentSessionId`, its list returns `{ childSessionId, watch }`, and startup
reconciliation feeds every result to the child handler — reusing either would misroute.

Pending-state classification must be one shared **exhaustive** predicate used by the
list query, the retry supervisor, and `PollingGlobalGate`. `isTerminalWatchState` is
module-private and controls none of them; `listPendingMergeWatches` independently
hard-codes `armed || merge-observed`.

No `completed-without-pr` state: whether a PR resulted is the PR card's business.

## The arm card

Do-then-surface: a persisted card stating the captured follow-up and remaining plan,
with a **Cancel**. Emit via `emitChatCard` — the arm happens mid-turn, an agent tool
call, which is the side-channel shape CLAUDE.md's persistence invariant covers. Cancel
carries `watchId` so a stale card action cannot hit a newer watch.

**Terminal outcomes append a second card** rather than patching the first — the pattern
SHI-258 actually uses. An earlier draft specified in-place transitions, which forced
`persistCardTransition` to work with **no runner attached** (the `expired` path starts no
turn) — a change to shared machinery, to reach a marginally tidier transcript. Appending
needs no such change, and reads correctly anyway: "armed at 09:00" and "expired at 14:20,
PR closed" are two events.

## Known gaps (tracked separately, not blocking)

- **A dispatch that throws during setup strands its settlement — SHI-263.**
  `dispatchOnRunner` fire-and-forgets `runDispatchedTurn` with no rejection handler, and
  the settlement's `finally` lives inside the executor's `done` handler — so a throw
  during attachment preparation or `createAgent` leaves the handle unresolved, `running`
  stuck true, and SHI-258's `isDeliveryInFlight` reporting the attempt as permanently in
  flight (no retry, no `delivery-failed`). Delivery here must not assume a settlement
  always arrives.
- **Restart during a wake can duplicate it — SHI-264.** Adoption carries no delivery
  identity and reconstructs no settlement, so reconcile may queue a second wake behind
  the surviving first. The reset command's gate makes the duplicate refuse rather than
  destroy, so the cost is bounded to a spurious turn — but relying on a downstream gate
  is not a fix. Resolved properly by the durable `deliveryId` docs/240 deferred.
- **A session that is both parent-watched and self-watching can collide in the retry
  supervisor**, whose `inFlight` and `lastTerminalInfo` maps are keyed by session id. One
  settlement clears the shared marker and the other attempt can look stalled. Uncommon
  enough to document rather than refactor shared machinery ahead of anyone hitting it.
- **Eviction.** Disk descent does not exempt pending watches, and a wake against an
  evicted checkout boots a container over a missing directory. Delivery must restore the
  workspace first. Materializing a checkout is not mutating the branch, so this is
  consistent with the headline — but the headline's wording must be *"ShipIt does not
  mutate the session branch"*, not "no git work": `markMergedAndPruneExcess` deletes the
  remote branch, and the wake's post-turn flow auto-commits and pushes like any turn.

## Prerequisites

- **SHI-262** — the queue drains before the finished turn's commit. Being fixed
  separately; until it lands, the gate is the only thing standing between a queued wake
  and a previous turn's uncommitted work.

## Key files

| Area | File | Change |
|---|---|---|
| Reset command | `services/pre-turn-reset.ts`, `agent-shim/shipit-*.ts`, `agent-ops-routes.ts` | `shipit branch reset-to-base` over the existing gate + fetch + reset + live-lease force-push |
| Watch state | `sessions.ts`, `shared/types/domain-types/session.ts`, `shared/database.ts` | `SelfMergeWatch` + column + migration; exhaustive pending predicate |
| Fire point | `app-lifecycle.ts` | Deliver right after `markMergedAndPruneExcess`, with PR identity |
| PR identity | `pr-status-poller.ts` | Carry `{prNumber, headSha, baseBranch}` into the merge callback; fan closed outcomes to expiry |
| Supersession | `services/pr-rearm.ts` | A docs/202 re-arm supersedes the watch |
| Delivery | `merge-watch.ts`, `wake-session.ts` | Self branch; startup reconcile; workspace restore before dispatch |
| Eviction | `tier-escalation.ts` | Pending watches keep their checkout, or delivery restores it |
| docs/218 overlap | `services/pre-turn-reset.ts`, `route-registry.ts` | Suppress `resetEligible` while a self-watch is pending |
| Prompt | `orchestrator/prompts/self-merge-wake.md` | Co-located template, `loadPrompt` at module top level |
| Card | `chat-card-persistence.ts`, `chat-history.ts`, client card + handler | Arm card, runner-less transition, Cancel with `watchId` |
| Agent docs | `shipit-docs/sessions.md` | `--self --then-file`, the reset command, chaining |

## Testing

- Arm refusals: archived, no branch, unparseable remote, no open PR, inline `--then`,
  empty/oversized instruction. Already-merged at arm → fires now.
- Amend replaces an `armed` watch; is refused once `merge-observed`.
- Fires after merge bookkeeping, not before.
- **Crash between terminal-snapshot persist and delivery still wakes** (startup reconcile).
- Closed-unmerged expires with no turn, including after a restart.
- A docs/202 re-arm supersedes rather than retargets.
- Reset command refuses on: dirty tree, `HEAD ≠ mergedHeadSha`, detached HEAD, active
  sequencer — and the wake reports rather than working around it.
- A wake queued behind a turn with uncommitted edits does not destroy them.
- Restart during a wake does not produce a second *destructive* turn.
- Child-watch and self-watch on one session do not collide in the supervisor.
- Evicted workspace is restored before dispatch (distinct from a reaped container).
- Cancel-vs-merge ordering, late settlement after cancel, stale-card cancel after re-arm.
- Chaining: a three-step plan runs three links; Cancel stops it mid-chain; each link
  re-arms with the remaining plan.
- Card round-trip, no duplicate on replay, `expired` transition with no runner.

## Resolved decisions

- **Nothing unbidden, nothing outside a turn.** The rebase happens because the agent
  asked for it, during its turn — which is what removed the preparation lease,
  write-ahead staging, git coordinator, and reset coordinator from earlier drafts. The
  orchestrator still executes it; the invariant is about *when and why*, not *which
  process*.
- **…via `shipit branch reset-to-base`, not prompt instructions.** Both reviews found
  the prompt-only form unsafe, and its gate is the common mitigation for three hazards.
- **Chaining is allowed** until the captured plan is exhausted; every link is gated on a
  real merge.
- **One path for manual and automatic merges**, no ShipIt-side fast path.
- **Opt-in, armed explicitly**, with the follow-up captured at arm time.
- **`--then-file`, never inline.**
- **An open PR is required to arm**, and the watch anchors to its number at arm time;
  the terminal head SHA is a separate safety anchor, not identity.
- **`armed → merge-observed → delivered`** — the intermediate state is what the retry
  supervisor and reconcile key on.
- **Chaining lives at the agent level**: one watch, armed repeatedly, with the remaining
  plan carried in each re-arm's follow-up text. ShipIt models no chain.
- **Arming always replaces** any existing watch, including a `merge-observed` one — the
  wake turn must be able to arm the next link.
- **Arming resolves the PR live**, never from the `pr_status` snapshot.
- **The reset command is a distinct service**, not the interactive policy wrapper, and is
  **idempotent** (already-at-base → proceed, not refuse).
- **A pending self-watch suppresses docs/218's `resetEligible`.**
- **Reuse docs/196's delivery and SHI-258's supervisor unchanged.** Refactoring the
  supervisor to key by `{kind, watchId}` was cut — it only matters when one session is
  simultaneously parent-watched and self-watching, which is uncommon; see *Known gaps*.

## Open questions

_None._

## Review history

Four cross-agent rounds. Rounds 1–3 (against drafts where ShipIt performed the reset
before the turn) produced SHI-254, SHI-255, SHI-258, SHI-259, SHI-260 and
`docs/240-unlosable-turn-dispatch`. Round 4 reviewed the rewrite twice in parallel —
Codex with the full history, a fresh reviewer without it — and produced SHI-262 plus
the corrections above.

The recurring finding that this had become platform work was correct about the early
drafts. What remains is a command wrapping logic that already exists, a watch record, a
card, and a prompt template.
