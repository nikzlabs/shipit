# Checklist

- [x] Confirm the root cause against the deployed commit (`7ba4c72c`) rather than
      the diagnosis alone.
- [x] Add `awaitInstallCompletion()` — poll `/install/status` for the whole
      completion wait, re-armed after each probe resolves.
- [x] Keep the wait unbounded so a slow install is never cut short (req 3).
- [x] Leave `releaseInstallGate` and the gated-service crash exemption untouched
      (req 4).
- [x] Regression test: lost `install_done` mid-install, SSE never reconnects.
- [x] Regression test: the ServiceManager gate is released after that recovery.
- [x] Verify both new tests hang without the fix and pass with it.
- [x] `npm run test:dev`, `npm run lint:dev`, `npm run typecheck`.
- [x] Rebase onto the latest default branch before opening the PR.
- [x] Independent review.
- [x] Review finding: correlate each probe with its install generation so a late
      answer cannot resolve the next install (req 5), with a regression test.
- [x] Review finding: scope the bracket test's name and comments to what it
      actually observes.
- [x] Review finding: record the hung-`_gatedTeardown` hole as separate and
      unfixed rather than letting req 1 imply it is closed.

## Follow-up — closing the deferred hole

- [x] Bound the gated teardown's `compose stop` in `stopGatedForReinstall`, so
      the promise `releaseInstallGate` awaits always settles (req 1).
- [x] Keep the bound far past `compose stop`'s own 10s grace period so the
      docs/239 wait is unchanged in every case it was written for (req 4).
- [x] Stamp each teardown with a gate generation so only its own cycle's release
      can open the gate (req 6); bump it on `start()` too.
- [x] Regression test: a `compose stop` that never returns still reopens the gate.
- [x] Regression test: an older teardown does not open a newer cycle's gate.
- [x] End-to-end test spanning both halves against a real `ServiceManager`.
- [x] Verify each new test fails with its own fix reverted — the end-to-end one
      passed on the first draft and had to be rewritten (see plan.md).
- [x] `npm run test:dev`, `npm run lint:dev`, `npm run typecheck`.
- [x] Independent review.
- [x] Comment on planning#479.
