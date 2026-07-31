# 241 — Spec discipline checklist

- [ ] Resolve the open question in requirements.md: is review-of-history enough for requirement 5's "cannot mark its own questions as answered" in v1? (blocks everything below, per the discipline's own gate)
- [ ] Config reader for `.shipit/spec-discipline.json` (`enabled`, `docsDir`) (req 8)
- [ ] Validator library: report entries under a feature's `## Open questions` heading as blocking findings with file and line (req 5)
- [ ] `SpecGateService` + turn-start consult in turn dispatch; clarification-turn designation (reqs 5, 10)
- [ ] Post-turn re-validation and finding surfacing for gated turns (req 5)
- [ ] Active-feature selection: inferred from launching issue, settable in chat, created mid-session (req 9)
- [ ] Fresh-context spec reviewer flow, cross-backend when available (req 6)
- [ ] Child-project init: config + skeleton + CLAUDE.md rules block, idempotent (reqs 7–8)
- [ ] Agent-facing doc in `src/server/shipit-docs/spec-discipline.md`
- [ ] Tests: validator open-question detection, gate integration test, opt-out (no config file) is a no-op
