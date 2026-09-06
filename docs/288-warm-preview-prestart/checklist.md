# Checklist — warm preview pre-start

- [x] Phase timings for activation→preview-ready (req 7): `container.acquire`,
      `install-gate`, `compose.up` build/create split, `preview.first-connect`.
- [x] Extract the ServiceManager construction out of `setupServiceManager` so
      the warm path and the runner path build the same object
      (`buildServiceManager`; guarded by
      `warm-preview-single-construction.test.ts`).
- [x] Warm pre-start: build + register + `start()` the manager after
      `runPreInstall`, inside the trust branch, gated on `lastUsedAt` recency
      (reqs 1, 2, 8) — `warm-preview.ts`.
- [x] Confirm adoption leaves a healthy pre-started stack alone — no reconcile
      restart (the overlay set is applied at warm time), no gate re-hold on a
      marker-skip install.
- [x] Idle enforcer tier 0: stop the warm stack before destroying the container,
      and credit `serviceBytes` as well as `agentBytes` (req 4).
- [x] Periodic warm sweep that rebuilds a warm session whose container is not
      running, whatever killed it — state-compared, not keyed on a transition
      (req 10). Fixed a gap that existed without this feature.
- [x] Boot sweep validates the standby is RUNNING, not just that the clone
      exists (`startup-tasks.ts`).
- [x] A claim that found no usable standby says so — the `claim-session` timing
      line carries `standby=ready|missing`, so it and the `container.acquire`
      line can be compared (req 11).
- [x] Warm-tier retirement at boot removes the pre-started compose containers,
      not just the standby agent container (req 6).
- [ ] Give `preview.first-connect` warm-vs-claim attribution (req 7). It measures
      from compose completion to the first proxied request, so a preview warmed
      overnight reports hours in that phase however fast it booted — the metric
      cannot currently substantiate the before/after below.
- [ ] Measure a warm claim before and after: `preview.first-connect` should stop
      being paid on the warm path.
- [ ] Detect a preview whose CONTAINERS were removed while its manager is still
      registered (req 10, residual). The sweep now repairs a missing manager —
      a failed pre-start, a tier-0 reclaim — but a stack the manager still
      believes it owns needs a per-service liveness probe.
