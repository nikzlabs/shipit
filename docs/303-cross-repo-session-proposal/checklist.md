# Checklist — propose work in another repository as a card

- [x] `RepoSessionProposalCard` domain type + WS message types
- [x] Shared validation module
- [x] `propose_repo_session` MCP tool + worker relay, enabled on all five harnesses
- [x] Orchestrator emit route (parse, own-repo guard, write-access check)
- [x] `ensureRepoReady()` extracted from `services/shipit-source.ts`
- [x] Start route (spawn detached, card transitions, stale-start recovery)
- [x] Chat-history column, migration, find/update, rehydration
- [x] Client card component + message handlers + transcript scoping
- [x] Tests: validation, emit route, start route, card component, handlers, history round-trip
- [x] `src/server/shipit-docs/sessions.md` — agent-facing documentation
- [x] lint:dev + typecheck clean
- [x] Independent review against the numbered requirements
