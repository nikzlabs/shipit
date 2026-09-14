# Checklist

- [x] Reproduce the incident order on a non-streaming system turn, red before the fix
- [x] Give the hold its own identity (`systemHoldSeq`) and release it only on a match
- [x] Keep another owner's hold untouched, with a test for a mid-turn handover and for a driver's hold
- [x] Return the `TurnHandle` from `wakeSessionWithTurn` and carry `admitted` on it
- [x] Report a queued wake in the consult delivery, the session report and merge-watch
- [x] Start a message queued between the result and the exit
- [x] Log the queue branch of `enqueueOrRefuse` and the compaction re-queue
- [x] `npm run test:dev`, `npm run lint:dev`, `npm run typecheck`
- [x] Full `npm test` — `TurnHandle` is a shared interface
- [x] Two independent reviews of the branch diff, acted on or filed (planning#554, planning#555)
