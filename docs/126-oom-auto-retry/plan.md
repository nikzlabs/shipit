
# OOM auto-retry — recover from preview OOM kills without Rescue session

## Problem

When a compose preview service is OOM-killed (exit code 137), the
service latches to `error` state and the user is left clicking **Rescue
session** as their only recovery. But Rescue is a heavy hammer — it
destroys+recreates the agent container and starts a brand-new compose
stack — and it doesn't fix the underlying issue: the new stack hits the
same memory condition and the same service gets OOM-killed again
moments later. From the user's perspective, "Rescue does nothing."

The symptom in the logs that triggered this work:

```
[compose] preview exited with code 137.
```

## Why the existing retry path doesn't cover this

`ServiceManager` already has an exponential-backoff retry path
(`scheduleRetryWhileInstalling` in `service-manager.ts`), but it's
gated on `_installRunning`. Its job is to handle the cold-start race
where a dev server tries to come up while `agent.install` is still
extracting `node_modules` into the bind-mounted workspace — once
install completes, the gate closes and any subsequent non-zero exit
goes straight to `error` with no retry.

That's the right policy for a generic exit (the build is genuinely
broken, retrying won't help), but exit 137 specifically is almost
always transient host pressure: a brief memory spike, another session
spinning up, a heavy build, a Vite watcher snapshot. The right move
is to retry the service a small number of times before giving up.

## Design

Add a parallel **OOM retry** path in `pollStatus` that fires only for
exit code 137 on `preview: auto` services. It mirrors the
install-window retry but with three guards:

1. **Bounded retry budget.** Max 3 consecutive OOM retries (constant
   `MAX_OOM_AUTO_RETRIES`). After that, latch to `error` with a
   message that names the budget and tells the user the actionable
   fix (raise the memory limit, close other sessions).

2. **Stable-uptime reset.** When a service that previously OOM-retried
   reaches `running`, arm a 60s stable-uptime timer. If it stays up
   that long, the retry counter clears — so a one-off OOM after hours
   of uptime gets its own fresh budget instead of inheriting a
   long-ago count. If the service leaves `running` before the timer
   fires, the counter is preserved so we hit the cap correctly.

3. **User-initiated reset.** `startService()` and `restartService()`
   clear the OOM counter explicitly — clicking "start" on an errored
   service is the user saying "try again," and they shouldn't have to
   work around an internal retry budget to get it to retry.

4. **Counter persistence after latch.** Once the budget is exhausted
   and we latch to `error`, the counter stays at MAX_OOM_AUTO_RETRIES.
   This is the critical anti-loop guard: the periodic poller will see
   the service still in `exited` state every 5 seconds, but the cap
   check in `scheduleOomRetry` immediately re-applies the error
   instead of starting a new retry round.

Manual services (`x-shipit-preview: manual`) are explicitly excluded
from auto-retry — manual is user-initiated by design, so let the user
re-trigger them.

## Why not also restart just the failed service inside Rescue?

That's a follow-up. The deeper fix would make Rescue smart enough to
detect "agent container is fine, only the compose service is broken"
and prefer a service restart over a full container destroy+recreate.
This feature deliberately stays narrow: the auto-retry kicks in
*before* the user reaches for Rescue, so the most common transient
OOM never escalates that far in the first place.

## Key files

### Server

- `src/server/orchestrator/service-manager.ts` — adds
  `oomRetryAttempts` / `oomStableTimers` state, `scheduleOomRetry()`,
  `armOomStableResetIfNeeded()`, `cancelOomStableTimer()`. The
  `pollStatus` exited branch routes exit-137 + `preview: auto` to the
  new retry path; `startService` / `restartService` reset the counter
  on user action; `cancelAllRetries` clears the new state alongside
  the install-window state.
- `src/server/orchestrator/service-manager.test.ts` — 5 new tests
  covering: retry on first OOM, latch after MAX consecutive OOMs,
  manual services excluded, user `startService` resets the budget,
  non-137 exits still latch immediately.

## Patterns this fits into

- **Service layer** (server-architecture skill): the retry logic
  lives entirely in `ServiceManager` — no new routes, no new WS
  messages, no client changes. The existing `service_status` event
  already carries the updated status and error string to the UI.
- **Idempotent recovery** (CLAUDE.md): the retry is bounded and
  self-terminating. Repeated OOMs land in the same `error` state with
  the same message — no work duplication, no resource leaks.
- **Inline beats link-out** (CLAUDE.md §2): the error message after
  retries exhaust explicitly names the actionable fix ("increase the
  service's memory limit or close other sessions to free host
  memory") so the user doesn't have to dig through Docker docs or
  open a host monitor tab.

## Out of scope

- Rescue session detecting "only the compose service is broken" and
  doing a lighter-touch recovery — separate follow-up if/when we see
  evidence the heavy-handed full destroy is the wrong default.
- Per-compose-service memory limits surfaced in shipit.yaml. Tracked
  in `docs/121-compose-resilience/plan.md` as a follow-up to the
  general compose-resilience work.
- OOM detection via the Docker event subscriber widening its label
  filter. That's part of `docs/124-session-rescue-and-diagnostics`
  §1.2 and is done; this feature complements it on the
  recovery-action side.
