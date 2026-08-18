# 275 — Role-less explicit run completeness: checklist

- [x] `requirements.md` + tracker item (planning#441)
- [x] `explicit.reasoningEffort` optional in `agent-types.ts`
- [x] `parseSpawnTarget`: per-harness completeness, blank `--effort=` refused
- [x] `resolveSpawnTarget`: no-levels refusal + missing-level refusal + unknown-agent refusal
- [x] Shim: local check drops `--effort`, message updated; `agent params` no-levels wording
- [x] Tests: grok four-flag target parses + resolves end to end; `--effort` on grok refused; level-having harness matrix unchanged; spawn receives no `reasoningEffort` key
- [x] Test: the role-path sibling — bare role on a level-less harness runs, `--effort` override onto it refused
- [x] Docs: `shipit-docs/agent.md` + `sessions.md`, docs/261 plan amendment, docs/274 plan + checklist note
- [x] lint:dev + typecheck + affected tests green
- [x] Independent review (`--role reviewer`) — all 7 requirements satisfied, no material findings
- [x] PR, label feature, `Closes planning#441`
