# 241 — Spec discipline checklist

- [x] Resolve the open questions in requirements.md (resolved 2026-07-31: review-of-history is the enforcement; first version is instructions-only, no new ShipIt functionality)
- [ ] Write the rules fragment `src/server/orchestrator/prompts/spec-discipline.md` — document format, when a feature is under the discipline, the four workflow rules, pointer to the platform doc (reqs 1–5, 8–10)
- [ ] Compose the fragment into the instruction skeleton in `agent-instructions.ts`, for both agent variants (req 7)
- [ ] Write the agent-facing platform doc `src/server/shipit-docs/spec-discipline.md` — full format and workflow reference (reqs 1–6)
- [ ] Document the post-implementation review convention in the platform doc: fresh-context reviewer via `shipit agent run` or a subagent, given requirements + branch diff vs PR base + checklist (req 6)
- [ ] Tests per the prompt-testing rules in CLAUDE.md: fragment present in every variant, no leftover `{{TOKEN}}`, precomputed-instructions reference equality unchanged (structural anchors only, no prose assertions)
- [ ] `npm run test:dev`, `npm run lint:dev`, `npm run typecheck`
