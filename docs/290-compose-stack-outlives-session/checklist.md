# 290 — checklist

- [x] `composeProjectName` as the single definition of `shipit-<sid12>`, shared with `ComposeCli.args()`.
- [x] `downComposeStackByProject` — label-driven teardown, no volumes, throws when it cannot establish the containers are gone.
- [x] `reapSurvivingComposeStacks` — boot pass with the five named holds, paced, re-checked before each teardown.
- [x] Wire the boot pass into `startup-monitors.ts` after `restoreReservedPreviews`.
- [x] `light → evicted` stops the stack before the wipe, and aborts the eviction when it cannot.
- [x] `hot → light`'s no-runner fallback stops a stack with no manager.
- [x] Both rungs drop the stopped manager from `serviceManagers`.
- [x] Correct the three claims that shutdown already takes every stack down (`shutdown-manager.ts`, `restart-turn-reattach.ts`, `deployment/vps/deploy.sh`).
- [x] Unit tests: `compose-stack-reaper.test.ts` (17), four new cases in `disk-tier-escalation.test.ts`, each proven red without the fix.
- [x] Update docs/284 and docs/242 where they describe stack lifetime across restarts.
- [x] Sync the tracker.
