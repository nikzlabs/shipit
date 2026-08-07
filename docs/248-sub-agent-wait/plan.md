---
issue: planning#308
title: Waiting on a sub-agent run
description: Status-carrying exit codes plus a resilient segment-loop `--wait` for `shipit agent result`.
---

# Waiting on a sub-agent run

Implements [requirements.md](./requirements.md).

Two changes to `shipit agent result`, one small and one structural:

1. **Its exit code carries the run's status** instead of always being `0`
   (reqs 1–3).
2. **`--wait` blocks until the run reaches a terminal status**, using the same
   resilient segment loop docs/182 built for `shipit session wait` (reqs 4–7).

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The run finished with status `success`. |
| `4` | The run is still `pending` — either no `--wait`, or `--wait`'s timeout elapsed. |
| `3` | The run reached a terminal status that was not success (`error`, `timeout`, `cancelled`). |
| `1` | The lookup failed: unknown run id, ambiguous prefix, unreadable response, orchestrator unreachable. |
| `2` | Bad invocation — the shim-wide `fail()` default (unknown flag, two run ids, `--timeout` without `--wait`). |

`0`/`3` mirror docs/182's `WAIT_EXIT_IDLE` / `WAIT_EXIT_ERROR`. Pending is `4`,
not docs/182's `1`, **deliberately** (see the resolved question in
requirements.md). Both low codes were already taken by failures: this command
has used `fail(…, 1)` for a lookup error since planning#247, and `fail()`'s shim-wide
default is `2`. Reusing either would mean `until shipit agent result <id>; do …;
done` retries forever against a mistyped id or a typo'd flag — a condition that
can never clear. `4` is the only code that means "come back later", which is
what makes requirement 3 hold. Pinned by a test asserting all three are
distinct.

### A wrong exit code is the one unacceptable failure

The premise is "trust `$?` instead of reading the text", so the loop refuses an
answer it cannot read rather than guessing one. `cardStatusOf` returns `null`
for any 2xx body that is not a recognizable consult card — which is exactly what
`callBroker` produces (`{}`) when a response is reset or truncated *after* its
2xx headers. Such a body is retried like transport damage; it never becomes an
outcome and never defaults to "success". A wait that only ever saw unreadable
bodies exits `1`, not `0`.

## Server: a level-triggered wait over the persisted card

`waitForSubAgentResult` (`services/sub-agent.ts`) re-derives the outcome from the
**persisted consult card** on every iteration, exactly as docs/182 re-derives
child readiness from durable state. No in-memory registry of in-flight runs and
no completion event: an orchestrator restart cannot strand a wait, because any
fresh request recomputes the answer from the DB.

The card is created `pending` at spawn and patched to its terminal status when
the run finishes (docs/236, planning#280). **Verified that both patch paths land in
the DB**, since the wait reads only the DB:

- `persistCardTransition` (`chat-card-persistence.ts:383`) patches the *recorded*
  card when the originating turn is still in flight — and then calls
  `persistTurnInProgress`, which writes the whole turn snapshot, patched card
  included, as `in_progress=1` rows.
- Otherwise it calls `patchDb` → `ChatHistoryManager.updateSubAgentConsultCard`,
  which rewrites the finalized row.

`listSubAgentConsultCards` reads `SELECT … WHERE session_id = ?` with **no
`in_progress` filter** (`chat-history.ts:472`), so it observes the transition on
both paths. `replaceInProgress` wraps its delete+reinsert in a transaction, so a
poll can never observe a torn intermediate state.

Shape of the loop:

- **Fast path** — derive once before arming any timer; an already-terminal run
  returns immediately.
- **Pin the run id on first derive.** With no `spawnId` the caller means "the
  most recent run"; resolving that fresh each iteration would silently follow a
  *newer* run that started mid-wait. The first derive pins the id and the rest
  of the wait follows that one run. This pin lasts one *segment*, so the shim
  re-pins too: it replaces whatever the caller named (nothing, or a prefix) with
  the full id from the first readable response, and sends that on every later
  segment. Both halves are needed — without the shim half a multi-segment wait
  still switches runs between segments, and a prefix that was unique at the
  start can turn ambiguous once a newer run appears.
- **Poll interval 500 ms** (req 9). Cheap enough to be irrelevant against a
  multi-minute consult, and half a second of latency on such a run is not worth
  an event bus. To keep each poll small, `listSubAgentConsultCards` now selects
  only the `sub_agent_consult` column of rows where it is non-null, instead of
  loading and re-parsing every message row in the session.
- **Pace the shim loop.** A server that answers `pending` instantly — an older
  build that ignores `wait` — has not spent a segment, so the shim enforces a
  1-second floor per iteration. Without it the loop issued ~1000 requests per
  second for the length of the timeout.
- **`segmentMs`** bounds one server call: still pending when it elapses ⇒ resolve
  `{ outcome: "pending" }` rather than holding the socket open. The shim owns the
  overall deadline (req 5).

## Route and broker

`GET /api/sessions/:id/agent/result` gains `wait=true&timeout=N&segment=S`,
mirroring `GET /api/sessions/:parentId/children/:childId`. Without `wait` the
response is byte-identical to before; with it, the body is the card plus a
machine-readable `outcome` (`finished` | `pending`).

The worker broker (`agent-ops-routes.ts`) forwards the three params and bounds
the worker→orchestrator leg at `segment + 10s`, so a half-open socket fails fast
into a status-0 retry instead of hanging — the same budget docs/182 uses.

## Shim: the segment loop

`handleAgentResult` gains `--wait` and `--timeout SECONDS` (default 5 min, capped
at 30 min — the sub-agent wall-clock cap; there is no point waiting past the
longest a run can live). `--timeout` without `--wait` is a usage error rather
than an implicit wait, so a stray flag can never turn a quick read into a
five-minute block.

The loop is the same shape as `waitForChildOnce`: bounded segments beneath an
overall deadline, transport failures swallowed with exponential backoff and
never surfaced as an outcome. `isTransientStatus` moved to `shim-common.ts` so
both loops share one definition rather than drifting apart.

On a pending exit the shim prints the re-run command on stderr (req 7), which is
what makes a wait resumable across invocations: each call makes progress by
observing durable state, so there is nothing to lose by being interrupted.

## Key files

- `src/server/session/agent-shim/shipit-agent.ts` — `--wait`, the segment loop, exit codes
- `src/server/session/agent-shim/shim-common.ts` — shared `isTransientStatus`
- `src/server/orchestrator/services/sub-agent.ts` — `waitForSubAgentResult`
- `src/server/orchestrator/api-routes-agent.ts` — wait query params
- `src/server/session/agent-ops-routes.ts` — broker forwarding + timeout budget
- `src/server/orchestrator/chat-history.ts` — narrowed consult-card query
- `src/server/shipit-docs/agent.md` — agent-facing docs (req 10)

## A run stranded by an orchestrator restart — resolved in docs/249

The wait is restart-safe in the sense that matters to *it* — no in-memory wait
state exists to lose, so any fresh request recomputes the outcome. The run it is
waiting on was **not** equally durable, which used to make that sentence claim
more than it earned.

`runSubAgent` (`services/sub-agent.ts`) is the **only** writer of the card's
`pending` → terminal patch, and it performs it when the worker's synchronous
HTTP response returns. The worker keeps no durable record of completion, and
nothing reconciled consult cards at boot. So if the orchestrator was destroyed
mid-run, the card stayed `pending` forever: the UI showed a permanently
in-flight consult, and `--wait` correctly reported "still running" until its
timeout, again and again.

**Fixed by [docs/249](../249-consult-survives-orchestrator-restart/plan.md)
(planning#309).** A boot sweep marks every card left `pending` by a dead process
`cancelled`, carrying a `statusDetail` that says a restart lost the result. For
a waiting caller that is a deliberate change of observed behavior: the poll that
used to answer `4` ("still running") forever now answers `3` ("the run failed"),
so a retry loop terminates. What is *not* recovered is the sub-agent's output —
that was scoped out on purpose (docs/249 requirements); re-running the consult is
the answer.

The limitation was pre-existing (docs/236 / planning#280), not introduced here —
`--wait` only made it easier to notice, because a caller sits on the symptom
instead of glancing at a card.

## Follow-up, deliberately not built

`shipit agent run --detach` plus a completion wake — the orchestrator dispatches
a turn into the calling session when the run finishes, so nobody waits at all.
Strictly better for long consults and strictly more mechanism (dispatch
ordering against an in-flight turn, an idle or disposed caller, interaction with
the planning#264 drain). Waiting has to work regardless; that lands first.
