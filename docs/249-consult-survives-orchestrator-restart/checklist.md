# Checklist — consult survives an orchestrator restart

- [x] Verify every claim in SHI-307 at the source (sole writer, no worker record, no boot reconcile)
- [x] `requirements.md` first; open questions asked and answered with dated receipts
- [x] `SubAgentConsultCard.statusDetail` — ShipIt's commentary, distinct from the sub-agent's words
- [x] `ChatHistoryManager.listPendingSubAgentConsultCards()` — cross-session read
- [x] `updateSubAgentConsultCard(..., { finalize })` — survive an adopted turn's `replaceInProgress`
- [x] `reconcileOrphanedConsultCards` — the boot sweep, non-throwing
- [x] Wire at boot, before `reattachInFlightTurns`
- [x] Render `statusDetail` on the card face
- [x] Print `statusDetail` on the shim's stderr (never stdout)
- [x] Unit tests: policy, idempotency, failure isolation, adoption interaction
- [x] Integration test: seeded DB → real `buildApp` boot → terminal card
- [x] Shim tests: exit 3 not 4, stderr-not-stdout, `--wait` ends
- [x] Update the docs/248 "Known limitation" section to point here
- [x] `npm run typecheck`, `npm run lint:dev`, affected tests
- [x] Independent fresh-context review (Codex) against the numbered requirements
