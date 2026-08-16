# Checklist — a CLI-started turn announces itself on the global SSE

- [x] Broadcast `session_agent_started` from `adoptCliStartedTurn`, on the
      false→true edge only (no burst across a turn's task notifications).
- [x] Gate the broadcast on a streaming turn, where `turn-executor` re-arms the
      post-turn flow that broadcasts the matching `session_agent_finished`.
- [x] Decide the `activity` payload — omitted, with the reasoning recorded in
      `plan.md` and at the call site.
- [x] Verify the finish side is symmetric for adopted turns (`agent_result` and
      the streaming `done` path), so a session cannot be left reading as running.
- [x] Check the `session_attention` background-task set for the same gap — it has
      none (the runner announces `background_work`; one subscriber broadcasts).
- [x] Unit coverage in `agent-listeners.test.ts` (edge, no-burst, mid-turn,
      one-shot).
- [x] Integration coverage in `self-wake-sse.test.ts` over a real `/api/events`
      stream: `started` → `finished` pairing, and one start per adopted turn.
- [x] `npm run test:dev`, `npm run lint:dev`, `npm run typecheck`.
- [x] Independent review of the branch diff.
- [x] Review follow-up: pin the assistant edge on its own (not riding behind a
      self-wake), so the coverage fails if `adoptsCliStartedTurns` stops being
      wired.
- [x] Review follow-up: pin the pairing on the abnormal exit (`done` with no
      `agent_result`), not on the clean result alone.
- [x] Review follow-up: add `requirements.md` — the folder is what the rule
      attaches to, bug fix or not.
