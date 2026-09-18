# Install gate — liveness watchdog

- [x] `GATE_WATCHDOG_SETTLE_MS` + `ServiceManagerOptions.gateWatchdogSettleMs`
- [x] `_gateReleasesInFlight` — count `releaseInstallGate`'s await so a healthy
      teardown is never read as a wedge (docs/239)
- [x] `checkInstallGateLiveness()` with the four-condition predicate and the
      settling delay
- [x] Wire it into the poller's `afterPoll` heartbeat
- [x] Log every silent early return on the gate-open path (`open()`,
      `startGatedServices`, the superseded-generation continuation)
- [x] Integration tests in `install-gate.test.ts`, each verified to fail with
      its own guard deleted
- [x] `npm run test:dev`, `npm run lint:dev`, `npm run typecheck`
- [x] Independent review (Codex)

## From review

- [x] Re-apply the `stoppedByUser` filter in `startGatedBatch` — the filter in
      `startGatedServices` runs before the stack queue, so a Stop landing while
      the batch waits was undone (requirement 5, one layer down)
- [x] Drop `_gatedTeardown === null` from the predicate — unreachable-true, and
      its only possible effect is to suppress a real recovery
- [x] Drop the `_gateWedgedGeneration` re-arm — no test can fail without it and
      the window it was documented to close does not exist (`reconcile()` stops
      the poller before `start()`)
- [x] Drop the unreachable `_disposed` log; gate the empty-set log on `_started`
      so it isn't boot noise
- [x] Make the positive test go through the real mid-session bracket, so the
      service is genuinely stopped by our teardown first
- [x] End every negative test by removing the one blocking condition and
      watching the watchdog fire, so a deleted guard cannot false-pass
- [x] Assert the watchdog's own log line and the all-stopped-by-user line
      (requirement 4)
- [x] Make the load-bearing table in `plan.md` honest about what is NOT covered
- [x] Qualify the guarantee: recovery is one settle window after the first
      successful `docker compose ps`, and the watchdog covers a lost gate
      release, not a lost install completion
