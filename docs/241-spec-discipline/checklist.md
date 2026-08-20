# 241 — Spec discipline checklist

- [x] Resolve the open questions in requirements.md (resolved 2026-07-31: review-of-history is the enforcement; first version is instructions-only, no new ShipIt functionality)
- [x] Write the rules fragment `src/server/orchestrator/prompts/spec-discipline.md` — document format, when a feature is under the discipline, the four workflow rules, pointer to the platform doc (reqs 1–5, 8–10)
- [x] Compose the fragment into the instruction skeleton in `agent-instructions.ts`, for both agent variants (req 7)
- [x] Write the agent-facing platform doc `src/server/shipit-docs/spec-discipline.md` — full format and workflow reference (reqs 1–6)
- [x] Document the post-implementation review convention in the platform doc: fresh-context reviewer via `shipit agent run` or a subagent, given requirements + branch diff vs PR base + checklist (req 6)
- [x] Tests per the prompt-testing rules in CLAUDE.md: fragment present in every variant, no leftover `{{TOKEN}}`, precomputed-instructions reference equality unchanged (structural anchors only, no prose assertions)
- [x] `npm run test:dev`, `npm run lint:dev`, `npm run typecheck`

## 2026-08-20 — move the rules out of the product (req 11)

- [x] Delete `src/server/orchestrator/prompts/spec-discipline.md` and drop `{{SPEC_DISCIPLINE}}` from `skeleton.md` + `agent-instructions.ts`
- [x] Delete `src/server/shipit-docs/spec-discipline.md` and its bullet in the skeleton's platform-docs list
- [x] Carry the rules in `CLAUDE.md` instead — turn-start check, document shape, the five steps — in compact form, with no companion doc to point at
- [x] Delete the tests that existed only to pin the fragment and the page; add none — the only test edit that remains is narrowing "every variant names the role" to the variants that still have spawn guidance, which the deletion forces
- [x] `npm run test:dev`, `npm run lint:dev`, `npm run typecheck`
