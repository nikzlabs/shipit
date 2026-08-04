---
issue: https://linear.app/shipit-ai/issue/SHI-306
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
| `2` | The run is still `pending` — either no `--wait`, or `--wait`'s timeout elapsed. |
| `3` | The run reached a terminal status that was not success (`error`, `timeout`, `cancelled`). |
| `1` | The lookup failed: unknown run id, ambiguous id prefix, bad flags, orchestrator unreachable. |

`0`/`3` mirror docs/182's `WAIT_EXIT_IDLE` / `WAIT_EXIT_ERROR`. Pending is `2`
rather than docs/182's `1` **deliberately** (see the resolved question in
requirements.md): `1` is already the shim-wide `fail()` code for a broken
invocation, so `until shipit agent result <id>; do …; done` against a mistyped
id would retry forever on a condition that can never clear. `2` is the only code
that means "come back later", which is what makes requirement 3 hold.

## Server: a level-triggered wait over the persisted card

`waitForSubAgentResult` (`services/sub-agent.ts`) re-derives the outcome from the
**persisted consult card** on every iteration, exactly as docs/182 re-derives
child readiness from durable state. No in-memory registry of in-flight runs and
no completion event: an orchestrator restart cannot strand a wait, because any
fresh request recomputes the answer from the DB.

The card is created `pending` at spawn and patched to its terminal status when
the run finishes (docs/236, SHI-278). **Verified that both patch paths land in
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
  of the wait follows that one run.
- **Poll interval 500 ms** (req 9). Cheap enough to be irrelevant against a
  multi-minute consult, and half a second of latency on such a run is not worth
  an event bus. To keep each poll small, `listSubAgentConsultCards` now selects
  only the `sub_agent_consult` column of rows where it is non-null, instead of
  loading and re-parsing every message row in the session.
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

## Follow-up, deliberately not built

`shipit agent run --detach` plus a completion wake — the orchestrator dispatches
a turn into the calling session when the run finishes, so nobody waits at all.
Strictly better for long consults and strictly more mechanism (dispatch
ordering against an in-flight turn, an idle or disposed caller, interaction with
the SHI-262 drain). Waiting has to work regardless; that lands first.
