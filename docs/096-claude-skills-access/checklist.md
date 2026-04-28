# 096 — `.claude/skills/` Access — Checklist

- [x] Update `src/server/shared/file-tree.ts` (and/or `fs-constants.ts`) to allow `.claude` in the hidden-directory allow-list.
- [x] Test for the new behaviour added to `file-tree.test.ts` (13 tests pass).
- [ ] **(Manual / out-of-band)** Create `.claude/settings.json` with the scoped permissions block from `plan.md` § "Fix 2". The agent cannot create this file unaided — the harness blocks writes inside `.claude/` until permissions are granted, which is the very file we're trying to create. Run `mkdir -p .claude && cat > .claude/settings.json` from a terminal, or accept the IDE permission prompt on first write attempt.
- [ ] Once the settings file exists, apply the deferred skill edit: insert the WebSocket-lifecycle rule into `.claude/skills/server-architecture/SKILL.md` (text in `plan.md` Appendix A).
- [ ] Verify the file tree panel now shows `.claude/skills/`.
- [ ] Verify the agent can edit `.claude/skills/*.md` without a permission prompt blocking the operation.
- [ ] Lint, typecheck, full suite.
- [ ] Mark `status: done` in `plan.md`.
