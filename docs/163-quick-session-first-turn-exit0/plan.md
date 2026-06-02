---
description: Quick/warm-standby first turn silently never ran — the dispatch path swallowed a no-result exit-0 instead of retrying or surfacing an error.
---

# Quick-session first turn silently never ran (no-result exit-0)

## Symptom

On the "quick session" / warm-standby path, the first turn's agent silently
never does any work. The user sees the initial file store in the UI, the branch
even gets auto-renamed from the title, but the agent makes no edits, no commit,
no PR — and **no error is surfaced**. Resending the prompt is a known
workaround. Reproduced repeatedly in production.

### Live evidence (wedged session `2b779931-…`, warm reconnect)

Orchestrator timeline:

```
12:56:33.508  [turn] env-prep took 236ms          ← fast
12:56:33.509  [turn] build-run-params took 1ms; spawning agent   ← agent.run() fires
12:56:38.715  Renamed branch (graduate naming)
12:56:41.206  [turn] agent exited with code 0      ← `done`, code 0, NO agent_result
12:56:49.133  [ws] session client connected        ← UI attaches AFTER the agent already exited
```

The process emitted `done` with `code 0` and `receivedResult === false`, ~100ms
after the install gate resolved, and **the turn was reported as completed.**

## Why this is a NEW variant — distinct from docs/162

`docs/162-fast-install-gate-race` (status: done) fixed two *hangs* where the
first turn never ended and the worker never saw `/agent/start`:

1. The fast-install gate hung on a racy SSE `install_done`.
2. The warm-pool follow-up where an un-timed `prepareAgentEnv` MCP-OAuth await
   stalled before `agent.run()`.

This case is past both of those:

- env-prep is fast (236ms) and build-run-params is 1ms — the docs/162 fail-open
  timeouts never engage.
- `agent.run()` **does** fire (`turn-executor.ts` logs `spawning agent`), so we
  are past the install gate and past env-prep.
- Yet the agent emits `done(code=0)` with `receivedResult === false`. The turn
  is not hung — it *ends*, but ends as a phantom "success".

So docs/162's hang fixes can't apply: there is no hang. The defect here is that
a turn which produced no result is treated as a completed turn.

## Root cause of the masking (the actual code bug)

The executor's "process exited without ever producing a result" branch was only
wired to surface anything on the **WS** turn path:
`emitErrorOnNoResult` is set in `ws-handlers/agent-execution.ts` but the
dispatched (quick / headless / child / CI-fix) path left it unset. So in
`turn-executor.ts`'s `agent.on("done")` handler, a dispatched turn with
`!receivedResult` fell straight through to the normal
`tryDrain → runCommitAndPr → emitFinishedIfIdle` teardown — i.e. it reported a
**completed turn** for a turn that did nothing, with no error and no chat row.

That silent success is exactly why the user "sees no error" and why resending
(which starts a brand-new turn) works. The underlying reason the warm-reconnect
CLI sometimes exits 0 without a result is a transient at the warm-worker / CLI
boundary; the orchestrator's job is to **not** treat that as success — and to
recover from it automatically, which is what resending already proved works.

## Fix

Two parts, in the shared executor + the dispatch adapter only (the WS path is
untouched — it keeps `emitErrorOnNoResult`):

1. **`turn-executor.ts`** — new optional `TurnInput.onNoResultExit` hook. In the
   non-streaming `done` handler, when the process exits with `!receivedResult`,
   was not user-interrupted, and did not hit `auth_required`, the hook runs
   **before** the normal teardown. If it returns `true` (it claimed the turn —
   retry dispatched or error surfaced), the executor does NOT finalize the turn
   as completed. `auth_required` is captured and excluded so an auth-blocked
   turn (which legitimately ends without a result and already shows a row) isn't
   retried.

2. **`dispatched-turn.ts`** — supplies `onNoResultExit`. A dispatched first turn
   that exits with no result is **auto-retried once** (the user's manual
   "resend" workaround, automated, bounded by `MAX_NO_RESULT_RETRIES = 1`). The
   retry reuses the same prompt but suppresses the duplicate user echo / chat
   row. If the retry *also* produces no result, it emits the agent's `error`
   event so the failure surfaces through the existing error path (chat error
   row + `session_status` reset + `session_agent_finished` + queue drain)
   instead of vanishing.

## Key files

- `src/server/orchestrator/turn-executor.ts` — `onNoResultExit` on `TurnInput`;
  `auth_required` capture; invoke the hook in the non-streaming `done` tail
  before teardown.
- `src/server/orchestrator/dispatched-turn.ts` — `runOnce(attempt)` loop,
  `MAX_NO_RESULT_RETRIES`, retry-then-surface-error wiring; first-attempt-only
  user echo / persistence.
- `src/server/orchestrator/integration_tests/quick-session-first-turn-exit0.test.ts`
  — regression tests.

## Verification

`npx vitest run src/server/orchestrator/integration_tests/quick-session-first-turn-exit0.test.ts`
— 4 tests:

- first no-result exit retries once (a second agent spawns, retry announced);
- a second no-result exit surfaces a visible error + finished + `running=false`,
  bounded to 2 attempts;
- a normal turn (`agent_result` then `done`) does NOT retry and surfaces no
  error;
- an `auth_required` turn does NOT retry.

Reverting the `onNoResultExit` wiring makes the retry/surface tests bite (the
turn silently finishes with a single agent and no error); the two negative tests
stay green. Related suites unaffected:
`fast-install-gate.test.ts`, `session-agent-env.test.ts`,
`session-runner.test.ts`, `dispatched-turn-race.test.ts`,
`agent-dispatch-route.test.ts`, `container-agent-wiring.test.ts`,
`container-exit-logging.test.ts`.
