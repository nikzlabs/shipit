# Checklist — warm preview pre-start

- [x] Phase timings for activation→preview-ready (req 7): `container.acquire`,
      `install-gate`, `compose.up` build/create split, `preview.first-connect`.
- [ ] Extract the ServiceManager construction out of `setupServiceManager` so
      the warm path and the runner path build the same object.
- [ ] Warm pre-start: build + register + `start()` the manager after
      `runPreInstall`, inside the trust branch, gated on `lastUsedAt` recency
      (reqs 1, 2, 8).
- [ ] Confirm adoption leaves a healthy pre-started stack alone — no reconcile
      restart, no gate re-hold on a marker-skip install.
- [ ] Idle enforcer tier 0: stop the warm stack before destroying the container,
      and credit `serviceBytes` as well as `agentBytes` (req 4).
- [x] Periodic warm sweep that rebuilds a warm session whose container is not
      running, whatever killed it — state-compared, not keyed on a transition
      (req 10). Fixed a gap that existed without this feature.
- [x] Boot sweep validates the standby is RUNNING, not just that the clone
      exists (`startup-tasks.ts`).
- [x] A claim that found no usable standby says so — the `claim-session` timing
      line carries `standby=ready|missing`, so it and the `container.acquire`
      line can be compared (req 11).
- [ ] Warm-tier retirement at boot removes the pre-started compose containers,
      not just the standby agent container (req 6).
- [ ] Measure a warm claim before and after: `preview.first-connect` should stop
      being paid on the warm path.
