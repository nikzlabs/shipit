# Checklist — a branch ahead of its remote heals itself

- [x] `BranchAheadHealer` with the idle / armed / merged / back-off decision
- [x] `PrStatusPoller.healBranchAhead`, called from the poll loop with the sync it already read
- [x] Wire the process-lived `AutoPushScheduler` into the poller (bootstrap → `createPrStatusPoller`)
- [x] Post-turn: arm the push when a turn that moved nothing leaves the branch ahead
- [x] `postInterruptCommitDepsFrom` — one builder, so no call site can omit `scheduleAutoPush` again
- [x] `restartAgent` flushes the commit and push before disposing the runner
- [x] `BranchSyncIndicator` on the PR card's merge row
- [x] Unit, integration and client tests; each new guard proved red without its fix
- [x] `npm run test:dev`, `npm run lint:dev`, `npm run typecheck`
