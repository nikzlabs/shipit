---
issue: planning#500
title: systemTurn, useStreaming and agent_self_wake
description: Why a backgrounded consult's result never reached the agent on a ShipIt-started turn, and how the result is now delivered.
---

# systemTurn, useStreaming and `agent_self_wake`

Implements [requirements.md](./requirements.md).

Diagnosed in a read-only ops session against production build
`bd2056521352`, from two incidents in one session on 2026-09-03.

## Symptom

The agent backgrounded a `shipit agent run --role reviewer` consult. The consult
finished correctly (9 and 18 minutes later), its card was persisted, and the user
saw the review in the transcript. **The agent was never re-invoked and never
acted on it.** The session also displayed as busy for the whole time, so the user
could not tell the agent had stopped. Both times the user had to type a message
to get anything to move.

## The three-way interaction

These three mechanisms are individually documented and were never written down
together. Read in this order they explain the whole failure.

### 1. `systemTurn` forces one-shot

Every ShipIt-started turn goes through `runDispatchedTurn` with
`systemTurn: true` — a merged child's PR (`merge-watch.ts` → `wakeSessionWithTurn`),
a child's upward report (`services/session-report.ts`), the rebase driver, CI
auto-fix. At `dispatched-turn.ts`:

```ts
const steer = opts.systemTurn ? undefined : deps.steerInputs?.();
const useStreaming = steer ? steer.liveSteering && steer.steeringCapable : false;
```

So `useStreaming` is **always false** for a system turn. That is deliberate:
system turns are explicitly never steered, and `systemTurn` also gates the
clean-spawn-boundary kill and the "a wake turn is never steerable" invariant
(`docs/240-unlosable-turn-dispatch/plan.md:166`).

### 2. A one-shot CLI cannot self-wake

`agent_self_wake` (docs/235) is how a *resident streaming* CLI reports that a
`Bash(run_in_background)` job finished and it is starting a turn of its own. A
one-shot CLI reaps its background jobs and exits at turn end (docs/235 probe A,
restated in `background-task-tracker.ts`), and `turn-executor`'s `beginRearm`
refuses to re-arm a non-streaming turn ("Streaming only … no resident process to
wake"). So on a system turn the CLI-side delivery path does not exist.

### 3. Nothing else was delivering the result

`services/sub-agent.ts` → `finalizeConsultCard` persisted the card and emitted it
to attached viewers. It dispatched no turn. The consult therefore completed
server-side, the card was durable, the user could read it — and nothing told the
agent. Since `/shipit-docs/agent.md` actively recommends backgrounding a consult
(a real review outruns the harness's 10-minute foreground tool cap), this is the
**normal path for cross-agent review**, not a corner case.

## Defect 2: the runner latched busy

Separately, `turn-executor.ts`'s `done` handler cleared `running` in its
**streaming** branch and not in its **non-streaming** one, which trusted
`agent_result` to have cleared it already (`agent-listeners.ts`).

That trust breaks when a `task_notification` arrives *after* `agent_result`:
`adoptCliStartedTurn` sets `runner.running = true` and, on a one-shot process,
nothing clears it again. `broadcastFinishedIfIdle` and `signalIdleIfIdle` are
guarded on the same flag, so they no-op too — no finished SSE, no idle signal, no
auto-remediation. Recovery came only from `Detected stuck running=true (worker
reports no agent). Resetting.` on the next user action, 45 and 5 minutes later.

`ws-handlers/agent-listeners.ts` used to describe this exact state as
"pre-existing, unreachable through the adapter". Production disproves it: a
`task_notification` arrived in the same second as process exit, in both
incidents. That comment now says so and points here.

## The fix

Two independent changes.

### Fix 1 — clear the latched flag (`turn-executor.ts`)

The non-streaming `done` branch now clears `running` in the same position the
streaming branch uses, immediately before the drain:

```ts
if (runner?.getAgent() === null) runner.running = false;
```

**Guarded on the agent slot being empty**, which the streaming branch gets from
its own identity check further up. Non-streaming spawns a fresh process per
turn, so this `done` can land *after* `agent_result`'s drain already started the
next turn — and that successor owns `running` now. An empty slot means the
identity guard cleared it for this agent and no successor has taken it.

Guard: `turn-self-wake-commit.test.ts` → "clears the latched running flag when a
task notification lands after a one-shot turn's result", which drives the
production event order `agent_result` → `agent_self_wake` → `done` on a
non-streaming turn and asserts the runner ends idle, the finished SSE is
broadcast, and the idle signal fires.

### Fix 2 — deliver the result by waking the session

`services/consult-result-delivery.ts` is the new module. It follows
`services/session-report.ts` exactly: the durable card is written first (by
`runSubAgent`), then a self-describing system turn is woken on top of it with
`wakeSessionWithTurn`. The prompt names the run id and points at `shipit agent
result <id>` rather than carrying a second copy of the output — the card is the
artifact (planning#247).

`runSubAgent` calls it in its `finally`, **after** `commitSubAgentWork`: the
wake can start a turn immediately, and a turn that begins by discarding
working-tree state would take the consult's own edits with it. It is awaited so
that ordering is a guarantee rather than a race; the gate below means a caller
still holding the HTTP call never reaches the wake, so no live consult pays the
container-resume wait.

**When it stands down** (each is a `reason` on the returned decision, and a test):

| reason | why |
|---|---|
| `originating-turn-live` | The runner is running AND its `turnEpoch` still equals the one captured at spawn admission — i.e. the caller is blocked inside `shipit agent run` and gets the text on stdout. A *later* turn running is deliberately **not** this case: `dispatch` enqueues behind it, and skipping there would lose the result all over again (a second child PR merging mid-consult is an ordinary shape). |
| `resident-cli-delivers` | `runner.isStreamingActive` — the resident CLI will raise `agent_self_wake` itself. |
| `cancelled-status` | ShipIt took the session away from the run; there is no result, and the wake would boot a container that was just stopped. |
| `already-delivered` | The stored card already carries `wakeDelivery`. |
| `no-session` | Gone or archived. |

A missing runner is **not** a stand-down: a disposed runner / restarted container
is exactly the case that lost the wake before, and `wakeSessionWithTurn` exists
to resume it.

**The record.** `SubAgentConsultCard.wakeDelivery` is stamped `queued` at
dispatch, then patched from the turn's own settlement (docs/240) — `delivered`
only on `completed`, `failed` with a detail otherwise. It serializes into the
card's single json column, so no migration and no `CARD_MESSAGE_FIELDS` change.
Its absence means "the agent had another way to see this", not "delivery
failed".

Nothing in the module throws: result delivery, the card and `shipit agent result`
keep working when the wake cannot run (req 5).

## What was deliberately not done

**Making system turns streaming.** `systemTurn` controls more than streaming
(see §1 above), and relaxing that gate would repair only the system-turn case.
Delivering the result explicitly also covers a SIGTERMed shim, a container
restart, a crashed CLI and a disposed runner, all of which lose the wake the same
way.

**A doc warning in `/shipit-docs/agent.md`.** Fix 2 leaves no residual case for
the shape the docs recommend, so a warning would describe a limitation that no
longer exists.

## Key files

- `src/server/orchestrator/services/consult-result-delivery.ts` — the delivery
  decision and the wake (+ `.test.ts`).
- `src/server/orchestrator/services/sub-agent.ts` — captures the originating
  turn epoch, keeps the terminal card, calls the delivery after the commit.
- `src/server/orchestrator/api-routes-agent.ts` — wires the wake deps, the same
  set `POST /api/sessions/:sessionId/report` passes.
- `src/server/orchestrator/turn-executor.ts` — Fix 1, in the non-streaming
  `done` branch.
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — the "unreachable"
  comments, corrected.
- `src/server/shared/types/domain-types/chat.ts` — `wakeDelivery` on the card.
