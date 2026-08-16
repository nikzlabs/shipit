---
issue: planning#399
title: A CLI-started turn announces itself on the global SSE
description: The sidebar showed "CI passed" for a session whose agent was working, because only orchestrator-started turns broadcast session_agent_started.
---

# A CLI-started turn announces itself on the global SSE

The session sidebar showed the green "CI passed" checkmark for a session whose
agent was in fact working. Switching into the session revealed it running.

## Root cause

`SessionStatusDot` (`src/client/components/SessionSidebar/SessionStatusIndicators.tsx`)
is correct and unchanged: "agent running" is priority 2, the CI check is
priority 5. The bug is that the client did not know the agent was running.

The dot reads `activeRunnerSessions`. Its only **additive** server input is the
global-SSE `session_agent_started` event, broadcast from exactly one place —
`turn-executor.ts:877` — i.e. only for turns the **orchestrator** starts.

A turn the CLI starts on its own is adopted by `adoptCliStartedTurn`
(`ws-handlers/agent-listeners.ts`). Two edges reach it: `agent_self_wake` (a
`Bash(run_in_background)` job finished — the shape a returning `shipit agent run`
consult produces) and top-level assistant output after the turn's own `result`
(docs/140). It set `runner.running = true` and emitted `session_status` over the
**per-session WebSocket**, which reaches only viewers already attached to that
session. Every other sidebar kept `isAgentRunning === false`, fell through
priority 2, and rendered the CI checkmark. Attaching reloaded HTTP history with
the authoritative `agentRunning`, which is why the truth appeared only on switch.

The removal path was never missing: `session_agent_finished` **is** an SSE
broadcast. The asymmetry was the whole bug.

Production evidence: session `5203c910`, 2026-08-16 UTC — 15+ `[cli-turn] …
adopted a turn the orchestrator did not start (self-wake)` lines between 10:22
and 10:41, including the 10:34:34 resume when a reviewer consult returned, with
the sidebar showing a checkmark for most of that window.

## The change

One broadcast, in `adoptCliStartedTurn`, under two conditions.

**Only on the false→true edge.** `adoptCliStartedTurn` runs on *every*
`agent_self_wake`, and that event rides the CLI's `task_notification`, which
fires whenever a background job reports back — 15+ times in one session in the
log above. Only the first is a real transition; a job started earlier in the
*current* turn reporting back mid-stream is not a new turn at all (docs/237). The
transition is captured as `startsTurn` before `running` moves, and every
once-per-adopted-turn effect hangs off it. An unconditional broadcast would emit
a burst of SSE frames to every browser per turn.

**Only on a streaming turn.** An adopted turn gets a post-turn flow — and with
it the matching `session_agent_finished` — only from `turn-executor`'s
`rearmForCliStartedTurn`, which `beginRearm` refuses to run when the turn is not
streaming (`turn-executor.ts:1526`, verified at the source). On a one-shot turn
the process's `done` reaches `broadcastFinishedIfIdle`, which is suppressed by
the very `running` flag adoption set — so a start announced there would never be
retracted, pinning a green dot on every sidebar. See "Adjacent gap" below.

**No `activity` field.** The client tolerates its absence. It would also be
invented rather than reported — nothing at the adoption point knows what the CLI
decided to do — and it is unused in this shape: the label is applied only to the
*active* session's status line, which the `session_status` emitted one line
earlier has already put into its loading state.

## What was verified, not assumed

- **The finish side is symmetric for adopted turns.** The re-armed flow
  broadcasts `session_agent_finished` at the adopted turn's `agent_result`
  (`turn-executor.ts:1636`) and, if that turn's process dies instead, on the
  streaming `done` path, which clears `running` first
  (`turn-executor.ts:1935-1937`). An interleaved wake cannot strand the
  predecessor's broadcast either: `broadcastFinishedIfIdle` is guarded on
  `runner.running`, so a wake that lands inside the predecessor's post-turn
  sequence suppresses that turn's finish and the adopted turn's own flow issues
  it instead.
- **The `session_attention` background-task set has no equivalent gap.** The
  listener only calls `runner.setBackgroundTasks`; the runner announces
  `background_work` and the single subscriber in `runner-registry-factory.ts:349`
  turns that into the cross-session `session_attention` broadcast (planning#246).
  The connect snapshot in `route-registry.ts:147` covers reconnects.
- **The restart-adoption path (docs/240) was already covered** — it runs through
  `executeAgentTurn`, so it broadcasts at `turn-executor.ts:877` like any other
  orchestrator-started turn (pinned by `restart-turn-adoption.test.ts:257`).

## Adjacent gap (not fixed here)

On a **non-streaming** turn, a self-wake arriving after `agent_result` sets
`runner.running = true` with nothing left to clear it: the non-streaming `done`
path never assigns `running = false` (it relies on the listener's `agent_result`,
already past), so its `broadcastFinishedIfIdle` and `signalIdleIfIdle` are both
suppressed and the runner also becomes undisposable. This is pre-existing and, per
the `agent_self_wake` branch's own note, not believed reachable through the
one-shot adapter (it reaps its background tasks and exits at turn end). It is out
of scope here — but it is the reason this change does not announce a start it
cannot promise to retract.

## Key files

- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — `adoptCliStartedTurn`;
  the broadcast and both gates.
- `src/server/orchestrator/turn-executor.ts` — `beginRearm` /
  `rearmForCliStartedTurn` (the re-arm that owns the matching finish),
  `broadcastFinishedIfIdle`.
- `src/client/hooks/useServerEvents.ts` — the `session_agent_started` /
  `session_agent_finished` handlers that maintain `activeRunnerSessions`.
- `src/server/orchestrator/ws-handlers/agent-listeners.test.ts` — edge, no-burst,
  mid-turn silence, one-shot silence.
- `src/server/orchestrator/integration_tests/self-wake-sse.test.ts` — the pair
  (`started` → `finished`) read off a real `/api/events` stream, and one start
  per adopted turn across a burst of notifications.
