# 324 — Agent-requested context compaction: checklist

- [x] `shipit compact [INSTRUCTIONS] [--note TEXT]` in the shim, with help text
- [x] Worker relay `POST /agent-ops/compact`
- [x] Orchestrator route `POST /api/sessions/:id/compact-after-turn`, refusing a harness that cannot compact
- [x] `sessions.pending_compaction` column, migration and accessors
- [x] Post-turn step: checks, compaction turn, continuation or instruction hand-back
- [x] Stop drops the note (step and Stop handlers)
- [x] Wiring into dispatched and interactive turns
- [x] Prompts in `orchestrator/prompts/`
- [x] Unit tests for the request, the step and the shim; executor placement test; end-to-end test
- [x] `shipit-docs/sessions.md` and the wiki
- [x] Independent review against the requirements, and its findings applied
- [x] `advanced.agentCompaction` setting, off by default, read by the route and the step (req 11)
