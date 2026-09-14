# Post-rebase follow-up — checklist

- [x] `services/rebase-followup.ts`: attempt-keyed window, appending notes, prompt composition, dispatch, handle observation
- [x] `prompts/post-rebase-followup.md`: the follow-up turn's text
- [x] `rebase-driver.ts`: open the window on the first conflict round, close it by attempt id, close it on the auto-resolve timeout path
- [x] `buildRebaseConflictPrompt` discloses the command — without it the feature is unreachable
- [x] `conflicts_resolved` carries the notes; `rebased` and `up_to_date` cannot
- [x] Delivery on the manual Sync path (`api-routes-git.ts`) and at the end of `runAutoResolveAttempt`, each after its own cleanup
- [x] `POST /api/sessions/:sessionId/continue-after-rebase` + worker relay + `shipit session continue-after-rebase`
- [x] Agent-facing docs: `shipit-docs/github.md`, `shipit-docs/sessions.md`
- [x] Tests: window unit tests, driver tests (multi-round, timeout, non-conflict outcomes), integration tests on the manual path, shim tests — each guard proved red on its own
- [ ] [planning#556](https://github.com/nikzlabs/shipit-planning/issues/556): the runner can still be reclaimed during the rebase's publication segment, so delivery has no ownership guarantee until that lands
