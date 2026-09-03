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
