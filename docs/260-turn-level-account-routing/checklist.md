# 260 — Turn-level account routing: checklist

- [x] `requirements.md` written from Nik's direction (2026-08-10)
- [x] Open questions answered by Nik (2026-08-10); receipts recorded, questions removed
- [x] `plan.md` designed against the numbered requirements (13, incl. req 13 added during design)
- [x] Simplification review round (removal brief) applied to the design
- [x] Cross-backend design review (Codex, run e9d4edbb) — all 11 findings triaged into the plan
- [x] Open question from the review (balanced-mode semantics) answered by Nik (2026-08-10: balanced spreads sessions)
- [x] Implementation (per-turn routing, refusal memory, attempt loop, marker-based identity, req-13 guards, disconnect/UI shrink; tests + typecheck + lint green)
- [x] Independent cross-backend review of the implementation against every numbered requirement (Codex, run 9e2b302a — 9 findings triaged: 8 fixed, 1 accepted as documented limitation; see plan §"Implementation-review triage")
