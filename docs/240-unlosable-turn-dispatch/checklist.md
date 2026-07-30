# Unlosable turn dispatch — checklist

## Fix A — branded prepared dispatch

- [x] `PreparedDispatch` branded type + `prepareDispatch(init)` producer — landed in a
      dedicated `prepared-dispatch.ts` (it owns the module-private `unique symbol`, so it
      is the only file that can mint one) and re-exported from `session-runner.ts`
- [x] `queuedMessageToDispatchOptions` returns `PreparedDispatch` (re-exported from
      `queue-drain.ts` so every existing drain's import path still works)
- [x] Exhaustive field mapping — a new `AgentDispatchOptions` field breaks the converter
      (`AgentDispatchInit` key-set assertions + `Record<keyof AgentDispatchOptions, true>`)
- [x] `dispatch` / `runDispatchedTurn` narrowed on both runner implementations
- [x] `toQueuedMessage` narrowed too, so `enqueue(toQueuedMessage(…))` isn't a back door
- [x] `turn-adoption.ts`'s hand-rolled `drainNext` no longer compiles; routed through
      `startQueuedMessage`
- [x] Non-queue callers migrated to `prepareDispatch` (wake-session, merge-watch via
      wake-session, CI auto-fix ×2, rebase driver, `sendChildMessage`, `spawnChildSession`,
      headless/quick sessions, `services/agent.ts`, the WS send-message fall-through)

## Fix B — settlement

- [x] `TurnHandle` / `TurnOutcome` (`turn-settlement.ts`); `dispatch` returns a handle
- [x] Executor resolves the settlement exactly once — `done` handler body wrapped in
      `try/finally`, with the flag-clearing half (`finishTurn`) kept out of the `finally`
      so a superseded retry attempt can't clear `systemTurnInProgress` under its successor
- [x] No-result retries are attempts within one settlement; attempt-zero guard **deleted**
- [x] `errored` outcome preserved — `wakeSessionWithTurn` passes the whole outcome through
      and `merge-watch` marks `delivered` only on `completed`
- [x] A discarded queue entry settles as `dropped` (`clearQueue` / runner disposal) instead
      of silently eating the signal
- [x] `onTurnComplete` kept as an adapter over `settled` (`withSettlement`)

## SHI-259's second half

- [x] The adoption sweep is awaited before watch reconciliation (`bootstrap-managers.ts`)

## Tests

- [x] Type-level: a hand-built `AgentDispatchOptions` passed to `dispatch` fails to compile
      (`prepared-dispatch.test.ts`, `@ts-expect-error` — an unused directive fails typecheck)
- [x] Type-level: an incomplete `prepareDispatch` init fails to compile
- [x] Exhaustiveness: adding a field without updating the converter fails
- [x] A callback-bearing system turn queued behind an **adopted** turn settles (SHI-259)
- [x] No-result retry that succeeds settles once with success (SHI-260)
- [x] Exhausted retries settle once with failure (SHI-260)
- [x] An errored turn settles with the error outcome
- [x] A dropped queue entry settles as `dropped`
- [x] Existing SHI-254 / SHI-255 / SHI-258 regressions still pass

## Follow-up (gated on docs/239)

- [ ] Durable `deliveryId` reported by the worker; liveness derived, not tracked
- [ ] Turn adoption re-settles a surviving delivery instead of redispatch
