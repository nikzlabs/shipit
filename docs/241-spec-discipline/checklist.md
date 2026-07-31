# 241 — Spec discipline checklist

- [x] Resolve the open question in requirements.md: review-of-history is enough for v1 (resolved 2026-07-31; requirement 5 reworded to match)
- [ ] Extend the `shipit.yaml` schema with the `spec-discipline` section (`enabled`, `docs-dir`) (req 8)
- [ ] Validator library: report entries under a feature's `## Open questions` heading as blocking findings with file and line (req 5)
- [ ] `SpecGateService` + turn-start consult in turn dispatch; clarification-turn designation (reqs 5, 10)
- [ ] Post-turn re-validation and finding surfacing for gated turns (req 5)
- [ ] Active-feature selection: inferred from launching issue, settable in chat, created mid-session (req 9)
- [ ] Spec-review convention on the existing fresh-context consult (`shipit agent run` / subagent): requirements + diff + checklist in, advisory findings out (req 6)
- [ ] Turn-on flow: on the human's request, agent adds the `spec-discipline` section to shipit.yaml and the feature-folder skeleton, overwriting nothing (reqs 7–8)
- [ ] Discipline rules fragment in agent instructions for opted-in workspaces (injected at the ShipIt level, not written to project CLAUDE.md) (req 3)
- [ ] Agent-facing doc in `src/server/shipit-docs/spec-discipline.md`
- [ ] Tests: validator open-question detection, gate integration test, opt-out (no `spec-discipline` section) is a no-op
