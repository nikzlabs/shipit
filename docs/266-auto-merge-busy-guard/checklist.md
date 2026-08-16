# 266 — Auto-merge busy guard: checklist

- [x] `AutoMergeManagedReason` on `AutoMergeState` and both broadcast shapes
- [x] `AutoMergeManager` takes a runner lookup and holds the merge on `agentBusy`
- [x] `setManaged` takes an options object and records the reason
- [x] Poller wires the runner lookup, exposes `hasLiveRunner`, broadcasts `managedReason`
- [x] `activatePendingAutoMergeForPr` / `toggleAutoMerge` arm managed while the session is live
- [x] UI merge button's pending-checks fallback arms managed for a live session
- [x] UI merge route widened from `running` to `agentBusy`
- [x] Merge / hold / terminal-attribution log lines
- [x] Client: distinct tooltip for the live-session case, no settings link
- [x] Client: `managedReason` carried from the toggle response
- [x] Tests — manager gate, poller wiring, arming, UI route post-turn 409, tooltip
- [x] Registry test fake reports `agentBusy` (was blind to the post-turn window)
- [x] `npm run test:dev`, `npm run lint:dev`, `npm run typecheck`
- [x] Independent review against the numbered requirements
- [x] Review findings applied: archived-session polling, `updateMergeMethod`, system-turn term, lifecycle-card wording, native attribution fallback, hold-log latch
- [x] Follow-up filed for restart persistence (planning#398)
- [x] Rebase onto `origin/main` and open the PR
