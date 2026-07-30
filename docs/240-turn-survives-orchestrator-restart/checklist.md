# Checklist

- [x] Worker tracks turn liveness (`turnActive`, `turnStartSseSeq`) separately from process residency
- [x] `GET /agent/status` publishes turn liveness + `runToken` / `agentId` / `streaming` / `oldestSseSeq`
- [x] `WorkerAgentStatus` shared between the worker and orchestrator layers, every new field optional (old worker images)
- [x] `ProxyAgentProcess` accepts an inherited `runToken`
- [x] `turn-adoption.ts` wires an in-flight worker turn through `executeAgentTurn` in `adopt` mode
- [x] `TurnInput.adopt` skips env-prep + spawn and the user-row persist
- [x] Pre-connect probe adopts a live turn / fast-forwards past a completed one
- [x] Concurrent `ensureWorkerResourcesStarted` callers serialize so SSE never opens mid-adoption
- [x] Boot sweep reattaches live turns without waiting for a viewer; leaves idle sessions alone
- [x] Integration test: fresh runner adopts a live worker turn, persists it exactly once, runs the post-turn commit/push flow
- [x] Unit tests for the boot sweep (idle / standby / archived / dead-worker cases)
- [x] `npm run typecheck`, `npm run lint:dev`, affected test files green
