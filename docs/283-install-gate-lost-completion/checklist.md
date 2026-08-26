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
