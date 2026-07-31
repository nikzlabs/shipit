# 241 — Spec discipline checklist

- [x] Resolve the open questions in requirements.md (all resolved in review, 2026-07-31 — became requirements 9 and 10; the project-wide summary idea moved to SHI-270)
- [ ] Validator library: find open-question markers, verify resolution entries cite real unused receipts (reqs 3, 5)
- [ ] `shipit spec check` CLI shim with `--feature` and `--json` (req 5)
- [ ] Receipt store: schema, persistence outside the workspace, read-only session exposure, reject non-user-answer creation (reqs 3, 5)
- [ ] Mint receipts from question-card answers; deliver answers as next turn (req 4)
- [ ] `SpecGateService` + turn-start consult in turn dispatch; clarification-turn designation (req 5)
- [ ] Post-turn re-validation and finding surfacing for gated turns (req 5)
- [ ] Fresh-context spec reviewer flow, cross-backend when available (req 6)
- [ ] Child-project init: config + skeleton + CLAUDE.md rules block, idempotent (req 7)
- [ ] Agent-facing doc in `src/server/shipit-docs/spec-discipline.md`
- [ ] Tests: validator findings table, receipt rejection paths, gate integration test, question→receipt round trip
