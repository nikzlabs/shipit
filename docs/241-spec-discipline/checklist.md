# 241 — Spec discipline checklist

- [ ] Resolve the three open `[NEEDS CLARIFICATION]` markers in plan.md (blocks everything below, per the discipline's own clarify gate)
- [ ] Validator library: parse opted-in `plan.md`/`checklist.md`, extract IDs, produce findings (241-REQ-010..016)
- [ ] `shipit spec check` CLI shim with `--feature`, `--all`, `--json` (241-REQ-010, 241-REQ-015)
- [ ] Receipt store: schema, persistence outside the workspace, read-only session exposure (241-REQ-020..022)
- [ ] Mint receipts from question-card answers; deliver answers as next turn (241-REQ-030..031)
- [ ] `SpecGateService` + turn-start consult in turn dispatch; clarification-turn designation (241-REQ-040..043)
- [ ] Post-turn re-validation and finding surfacing for gated turns (241-REQ-042)
- [ ] Fresh-context spec reviewer flow, cross-backend when available (241-REQ-050..051)
- [ ] Child-project init: config + skeleton + CLAUDE.md rules block, idempotent (241-REQ-060..061)
- [ ] Agent-facing doc in `src/server/shipit-docs/spec-discipline.md`
- [ ] Tests: validator findings table, receipt rejection paths, gate integration test, question→receipt round trip
