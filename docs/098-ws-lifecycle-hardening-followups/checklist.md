# 098 — WS-Lifecycle Hardening Follow-ups — Checklist

Each item is a separable unit of work. Tackle in any order; tick as you go.

- [ ] **Cap idle grace period** so flapping clients can't extend it indefinitely. See `plan.md` § 1.
- [ ] **Test: WS reconnect after idle cleanup completed.** See `plan.md` § 2.
- [ ] **Test: multi-viewer attach/detach race.** See `plan.md` § 3.
- [ ] **Test: grace-period boundary** (skipped at `−1ms`, disposed at `+1ms`). See `plan.md` § 4.
- [ ] **Test: force-disposal of a running agent via `archiveSession`** (integration, not just unit). See `plan.md` § 5.
- [ ] **Helper for repeated `runner.running = false`** state-clearing in `claude-execution.ts`. See `plan.md` § 6.
- [ ] **Delete or assert** the dead `!turnSessionId` else-branch in `agent-listeners.ts:83-90`. See `plan.md` § 7.
- [ ] **Adversarial timing tests** — close during `await activateSession(...)`; assert post-disconnect commit message correctness. See `plan.md` § 8.
- [ ] When all items done: mark `status: done` in `plan.md` and delete this checklist.
