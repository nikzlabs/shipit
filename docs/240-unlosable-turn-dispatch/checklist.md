# Unlosable turn dispatch — checklist

## Fix A — branded prepared dispatch

- [ ] `PreparedDispatch` branded type + `prepareDispatch(init)` producer (`session-runner.ts`)
- [ ] `queuedMessageToDispatchOptions` returns `PreparedDispatch` (`queue-drain.ts`)
- [ ] Exhaustive field mapping — a new `AgentDispatchOptions` field breaks the converter
- [ ] `dispatch` / `runDispatchedTurn` narrowed on both runner implementations
- [ ] `turn-adoption.ts`'s hand-rolled `drainNext` no longer compiles; routed through `startQueuedMessage`
- [ ] Non-queue callers migrated to `prepareDispatch` (wake-session, merge-watch, CI auto-fix, sendChildMessage)

## Fix B — settlement

- [ ] `TurnHandle` / `TurnOutcome`; `dispatch` returns a handle
- [ ] Executor resolves the settlement exactly once in a `finally`
- [ ] No-result retries are attempts within one settlement; attempt-zero guard deleted
- [ ] `errored` outcome preserved (not discarded as in `wakeSessionWithTurn`)
- [ ] `onTurnComplete` kept as an adapter over `settled`

## SHI-259's second half

- [ ] Await the adoption sweep before watch reconciliation (`bootstrap-managers.ts`)

## Tests

- [ ] Type-level: a hand-built `AgentDispatchOptions` passed to `dispatch` fails to compile
- [ ] Exhaustiveness: adding a field without updating the converter fails
- [ ] A callback-bearing system turn queued behind an **adopted** turn settles (SHI-259)
- [ ] No-result retry that succeeds settles once with success (SHI-260)
- [ ] Exhausted retries settle once with failure (SHI-260)
- [ ] An errored turn settles with the error outcome
- [ ] Existing SHI-254 / SHI-255 / SHI-258 regressions still pass

## Follow-up (gated on docs/239)

- [ ] Durable `deliveryId` reported by the worker; liveness derived, not tracked
- [ ] Turn adoption re-settles a surviving delivery instead of redispatch
