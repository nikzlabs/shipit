# Checklist — quick-session first-turn exit-0 (docs/163)

- [x] Reproduce in a test: a dispatched first turn that exits with no
      `agent_result` must not be reported as a completed turn.
- [x] Add `onNoResultExit` hook to `turn-executor.ts`, invoked before the
      non-streaming teardown; exclude interrupted + `auth_required` turns.
- [x] Wire the dispatch path (`dispatched-turn.ts`) to auto-retry once, then
      surface a visible error via the agent's `error` event.
- [x] Suppress duplicate user echo / chat row on the retry.
- [x] Regression test asserts: retry happens, error surfaces on exhaustion,
      normal turns don't retry, auth-blocked turns don't retry.
- [x] Confirm the tests bite on revert.
- [x] Run related existing suites (fast-install-gate, session-agent-env,
      session-runner, dispatched-turn-race, agent-dispatch-route,
      container-agent-wiring, container-exit-logging).
- [x] `npm run typecheck` and `npm run lint:dev` clean.
