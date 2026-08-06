# Checklist — agent-driven Compose service control

- [x] Per-action request timeouts (`service-request-timeouts.ts`) — start/restart
      get 600s instead of the flat 60s that broke every heavy service
- [x] `ServiceRequestQueue.enqueue` accepts a per-request timeout + message
- [x] Timed-out start/restart reported as "still running", naming `list`/`logs`
- [x] Worker `GET /services/logs?name=&lines=`; `timeoutMs` accepted on
      `start`/`restart` and consumed locally (not forwarded to the orchestrator)
- [x] `handleServiceRequest` returns the real post-poll status/error/port/url
      instead of a hardcoded `running`
- [x] `handleServiceRequest` `logs` action (ANSI-stripped `snapshotLogs`)
- [x] Already-running service reported as a no-op rather than a silent re-`up`
- [x] `shipit service list/start/stop/restart/logs` shim + `services` alias
- [x] `start`/`restart` on the unbounded transport (undici's 300s cap would
      abort a cold image pull)
- [x] `create`/`delete`/`build`/`exec`/`up`/`down` rejected → edit the compose file
- [x] Actionable errors: no compose stack, unknown service, stale worker (404)
- [x] System prompt — "Compose services" section + `live-preview.md` pointer
- [x] `shipit-docs/compose.md` "Controlling services", `preview.md`, `README.md`
- [x] `manual` rows no longer say "User clicks Start in UI"
- [x] Tests: shim (31), timeouts (11), queue (7), runner bridge (14), worker
      integration (+3)
- [x] `npm run typecheck`, `npm run lint:dev`, affected suites green

## Follow-up — stuck `starting`, no reachable address (#2044)

- [x] `getServices` publishes `url` for `starting` as well as `running`;
      `stopped`/`error` still withhold it
- [x] Per-service `starting` watchdog (`STARTING_WATCHDOG_MS`) → `error` with a
      reason, exempting in-flight `compose up` and the install gate (both re-arm)
- [x] Watchdogs cancelled on `stop()` and on `reconcile()`'s map rebuild
- [x] `joinSessionNetwork` bounded by `NETWORK_JOIN_TIMEOUT_MS` and logged
- [x] `poller.start()` moved into `start()`'s `finally` so a throw can't leave a
      session with no poll loop
- [x] `shipit-docs/preview.md` — `url` while `starting`, stuck-service troubleshooting
- [x] Tests: 8 cases in `service-manager.test.ts`; `npm run typecheck`,
      `npm run lint:dev`, orchestrator integration suite green
