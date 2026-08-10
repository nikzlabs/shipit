# Checklist — compose resilience

- [x] G — compose `up` output reaches the starting service's log panel (PR #2121)
- [x] D — a failing `docker compose ps` no longer freezes a `running` claim
      forever (`ServicePoller.expireUnconfirmedStatuses`, req 3)
- [x] F — the log follower is re-attached after an automatic recovery, and a
      follower that exits is retired from the registry (req 4)
- [x] H — the in-flight `compose up` exemption is bounded on silence, so a hung
      `up` is reported instead of pinning `starting` forever (req 2)
- [x] I — a stop issued during a start leaves the service stopped, and the stop's
      own SIGTERM/SIGKILL exit is not reported as a crash (req 5)
- [ ] E — bound the SSE reconnect retries and surface `worker_unreachable`
      (req 6). `container-session-runner.ts`, owned by a sibling session — not
      part of the D/F/H/I work.
