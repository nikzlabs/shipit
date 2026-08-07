---
issue: planning#309
title: A sub-agent consult survives an orchestrator restart
description: Boot reconcile that finishes consult cards stranded `pending` when the orchestrator died mid-run, so the card stops claiming to be in flight.
---

# A sub-agent consult survives an orchestrator restart

Implements [requirements.md](./requirements.md). Requirement numbers below cite
that document.

## The strand

`runSubAgent` (`services/sub-agent.ts`) is the **only** writer of a consult
card's `pending` → terminal patch, and it writes it when the worker's
synchronous `/agent/spawn` response returns. That response is an in-memory
promise. Two facts make it fragile:

- the **worker keeps no durable record** of a completed run — `agent-controller.ts`
  returns the result inline on the HTTP response and drops the handle in a
  `finally`;
- **nothing reconciled consult cards at boot** — verified by reading
  `startup-janitor.ts`, `steady-state-reclaim.ts`, and `startup-tasks.ts`: none
  of them referenced consult cards at all.

So when the orchestrator process died mid-run, the card stayed `pending`
forever. Session containers outlive an orchestrator restart (docs/240), so the
sub-agent itself usually ran to completion and wrote its output into a socket
whose other end was gone.

Observable, per stranded run:

| Surface | Before |
|---|---|
| Card in the transcript | spinner, "Asking Codex… in progress", forever |
| `shipit agent result` | `pending` → exit `4` ("still running") on every call |
| `shipit agent result --wait` | burns the full timeout, every time, forever |
| The sub-agent's output | lost |

The last row is not recovered here — that was the explicit scope decision
(requirements, resolved 2026-08-04). What changes is that the other three stop
lying.

## The fix: a boot sweep

`consult-card-reconcile.ts` — `reconcileOrphanedConsultCards(store)` — reads
every `pending` consult card in the database and patches each to `cancelled`
(req 8) with a ShipIt-authored `statusDetail` explaining that a restart lost the
result (reqs 1, 5).

### Why a boot sweep is safe, and why it must stay one

The hazard with any "mark the stale ones failed" pass is marking a **live** run
failed (req 6). This one cannot, and the reason is *when* it runs rather than
what it checks: a card can only be finished by the process that started it,
because that process holds the only handle. In a process that has just booted,
every `pending` card in the DB is by construction owned by a dead process. The
sweep runs once during boot, before any route can accept a new spawn — so there
is no live consult in scope and no liveness heuristic is needed.

That reasoning is load-bearing: moving this onto a periodic timer or a
per-activation hook would put genuinely in-flight consults in scope and cancel
them out from under their callers.

**The assumption it rests on, stated plainly:** one orchestrator per database.
Verified for the production path — `autoStart` builds exactly one app and calls
`app.listen()` only after `buildApp()` resolves (`app-lifecycle.ts`), and
`runSubAgent` has a single non-test entry point (the agent HTTP route). It is
*not* mechanically enforced: two `buildApp()` calls sharing an injected
`databaseManager` (`app-di.ts`) would let the second one's sweep cancel the
first's live card. That topology exists only in tests today, and a second
orchestrator on the same state directory would already be broken in more
serious ways (container rediscovery, SQLite writers, session ownership). Exclusive
ownership of the state directory would close it properly; that is a
platform-level concern, not this feature's.

**When the sweep itself fails, the card stays stranded until the next boot.**
`reconcileOrphanedConsultCards` logs and continues — a read failure returns
early, a per-row write failure skips that row. This is a deliberate trade:
the orchestrator owns every live session, so failing the boot over an
unreconciled card would turn a cosmetic-and-CLI problem into a total outage. The
cost is that requirements 1/3/4 depend on the sweep succeeding, and a failed one
leaves the original symptom in place. Pinned by the two failure-isolation tests.

### Finalizing the row — what protects the card from the docs/240 adoption

A consult spawned by a **foreground** `shipit agent run` is still inside its
originating turn when the orchestrator dies, so its card row is `in_progress=1`.
docs/240 then adopts that turn in the new process, and the adopted turn's
`agent_result` calls `replaceInProgress` — which deletes **every** `in_progress=1`
row in the session and rebuilds from the fresh runner's (empty) `recordedCards`
(verified at `chat-history.ts` `replaceInProgress` → `stmtDeleteInProgress`, and
`agent-listeners.ts`'s `agent_result` path via `turn-adoption.ts`). A status
patch alone would be undone by that delete, and the card would not merely stay
pending: it would be **gone**, with `shipit agent result` answering "No sub-agent
runs in this session yet" — the exact docs/236 failure.

So the patch also clears `in_progress` (`updateSubAgentConsultCard`'s `finalize`
option). **That is the protection**, and it is what the tests pin — not the call
ordering. Being precise about this matters, because the ordering looks like it
carries more weight than it does: the adopted turn's `replaceInProgress` fires at
its `agent_result`, seconds to minutes after boot, so the sweep would beat it
either way. Running before `reattachInFlightTurns` in `bootstrap-managers.ts`
closes the window rather than being the reason the card survives. Do not reorder
it — but do not mistake the ordering for the guarantee.

Pinned by three tests that fail in different directions:
`consult-card-reconcile.test.ts` → "survives an adopted turn's
replaceInProgress"; `chat-history.test.ts` → "without finalize, an in-progress
card is still deleted", which documents what `finalize` is for by showing the
loss; and the integration test's "boot leaves the card able to survive an adopted
turn's row rebuild", which asserts it through a real `buildApp`.

### Where the explanation lives: `statusDetail`, not `outputMarkdown`

`outputMarkdown` is the sub-agent's verbatim words. It is what
`shipit agent result` prints on **stdout**, and planning#247 guarantees it is the same
artifact the user reads. Writing ShipIt's apology there would hand a calling
agent our prose in the consultant's voice — the guarantee runs the other way.

So the card gets a new optional `statusDetail`: ShipIt's commentary on a
terminal status, rendered as such on both read surfaces —

- **the card face** — a second line under the summary
  (`sub-agent-consult-status-detail`), because "Cancelled Codex" alone is
  indistinguishable from a consult the *user* cancelled (req 5);
- **`shipit agent result`** — one line on **stderr**, where the shim's own
  commentary already lives, and in the `--json` body (which forwards the whole
  card, so it needed no change).

No migration: the card is a JSON blob in the existing `sub_agent_consult`
column.

### The intended behavior change for a waiting caller (req 7)

`shipit agent result` exits `4` for `pending` and `3` for a terminal
non-success. A stranded card made a polling caller loop on `4` forever; it now
gets `3` and stops. The shim needed no logic change for this — `exitCodeForResultStatus`
already maps `cancelled` to `3` — but it is a real change in observed behavior,
so it is covered explicitly in `shipit.test.ts` from both the one-shot and the
`--wait` side.

## Key files

| File | Role |
|---|---|
| `src/server/orchestrator/consult-card-reconcile.ts` | The sweep + the `cancelled` / `statusDetail` policy |
| `src/server/orchestrator/bootstrap-managers.ts` | Calls it at boot, before `reattachInFlightTurns` |
| `src/server/orchestrator/chat-history.ts` | `listPendingSubAgentConsultCards()` (cross-session read); `updateSubAgentConsultCard(..., { finalize })` |
| `src/server/shared/types/domain-types/chat.ts` | `SubAgentConsultCard.statusDetail` |
| `src/client/components/MessageList/cards/SubAgentCards.tsx` | Renders `statusDetail` under the summary |
| `src/server/session/agent-shim/shipit-agent.ts` | Prints `statusDetail` on stderr |
| `src/server/orchestrator/consult-card-reconcile.test.ts` | Sweep policy, idempotency, failure isolation, the adoption interaction |
| `src/server/orchestrator/integration_tests/consult-card-restart-reconcile.test.ts` | Seeds a killed orchestrator's DB, boots `buildApp`, asks what `shipit agent result` asks |
| `src/server/session/agent-shim/shipit.test.ts` | Exit `3` not `4`; stderr-not-stdout; the wait ends |

## What this does not do

Recover the lost output. Doing so would mean a durable worker-side record of
each run plus an orchestrator re-attach after restart — and would still need
this sweep underneath it, for the cases where the container died too. Scoped out
deliberately; planning#309's other harm ("the work was done and thrown away") remains
true, and re-running the consult is the answer.
