# Checklist

- [x] Clear the latched `running` flag in `turn-executor.ts`'s non-streaming `done` branch (req 6).
- [x] Regression test for `agent_result` → `agent_self_wake` → `done` on a non-streaming turn.
- [x] `services/consult-result-delivery.ts` — wake the session when a consult finishes and nothing else will (reqs 1, 2).
- [x] Stand-down gates: originating turn live, resident streaming CLI, cancelled, already delivered, archived (req 3).
- [x] `SubAgentConsultCard.wakeDelivery` — durable record, settled from the turn outcome (req 4).
- [x] Call the delivery from `runSubAgent`'s `finally`, after the commit; never let it cost the caller its result (req 5).
- [x] Wire the wake deps into `POST /api/sessions/:id/agent/spawn`.
- [x] Correct the "unreachable through the adapter" comments in `ws-handlers/agent-listeners.ts`.
- [x] Tell agents about the new behavior in `src/server/shipit-docs/agent.md`.
- [x] Design doc + requirements.
- [x] `npm run test:dev`, `npm run lint:dev`, `npm run typecheck`.
- [x] Independent review of the branch diff.
- [x] Act on the review: drain a message queued during the latched phantom turn; stamp `wakeDelivery` only after the dispatch is accepted; report an unstampable card; stop the delivery blocking the shim's HTTP response; record the residuals it found.
- [x] planning#695 — a wake that the agent may not have read (a Stop, a cancelled queue row, a failed start, a thrown wake) parks its prompt for the next turn (req 7).
- [x] Act on the reviews: share the stopped-jobs rule (`informingWakeMissed`) instead of `shouldRepark`; settle a drained turn whose setup threw, in all three setup catches; do not settle a dispatch that a failed compaction put back in the queue, held turns included (`settleDispatchSetupFailure`); count a CI fix that failed to start as no attempt; record the Sync residual.
