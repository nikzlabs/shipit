# Checklist

- [x] Harvest `State.OOMKilled` from the poller's existing per-container inspect
- [x] Thread `oomKilled` into `onExitedWithError` → `handleNonZeroExit`
- [x] Require a confirmed OOM for the OOM auto-retry branch
- [x] Three-valued terminal message (`describeExit`) — no memory advice when unconfirmed
- [x] Retain the re-install teardown promise and await it before reopening the gate
- [x] Stop gated services concurrently so the wait costs one grace period, not one per service
- [x] Reset the OOM budget when a service is re-gated for a re-install
- [x] Document the confirmed-OOM precondition on `scheduleOomRetry`
- [x] Poller tests: flag states, no-networks case, inspect failure, gated skip
- [x] `service-manager.test.ts`: unconfirmed 137 does not OOM-retry; post-gate ownership; gate held until teardown lands
- [x] `container-exit-logging.test.ts`: service path of the "137 is not proof of OOM" principle
- [x] Note in `docs/126-oom-auto-retry` that the trigger is now a confirmed OOM
</content>
