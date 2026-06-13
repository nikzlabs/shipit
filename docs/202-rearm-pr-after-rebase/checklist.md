# Checklist — Re-arm a merged session for a new PR after rebase

- [ ] `git.ts`: add two-dot diff helper + `advancedBeyondMergedBase(base)` (merge-base == base tip AND non-empty two-dot diff)
- [ ] `sessions.ts`: add `clearMerged(id)` (sets `merged_at = NULL`)
- [ ] `pr-status-poller.ts`: add `reArm(sessionId)` (drop from `mergedSessions`, re-`trackSession`)
- [ ] `services/pr-lifecycle.ts`: replace `if (session.mergedAt) return` with detect → re-arm → fall through to create/ready (turn-gated; no poller-tick sweep)
- [ ] Client: confirm `pr-store` prunes the stale merged card and the session regroups to Active (cleared `merged_at` in SSE session-update)
- [ ] Requirement: merged-but-progressed session is never visually archived and never fast-evicted
- [ ] Tests: git detection matrix (squash/regular × rebased/not × work/clean)
- [ ] Tests: `clearMerged` unit; poller re-arm integration; post-turn merged+progressed → new PR vs merged+clean → stays merged
- [ ] Resolve open question: re-armed card wording (clean "no PR" vs "previously merged" breadcrumb)
- [ ] Update this plan with any subsystems/patterns discovered during implementation
