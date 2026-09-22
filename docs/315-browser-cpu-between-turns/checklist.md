# Browser CPU between turns — implementation

- [x] `requirements.md` written before any implementation code, open questions resolved
      with dated receipts
- [x] `killDescendantTree` in `shared/kill-child.ts` — ownership by walking down from our
      own pid, reusing `signalIdentity` and the SIGKILL sweep
- [x] `session/agents/browser-reclaim.ts` — find managed browsers, sample tree CPU, gate
- [x] Hook from `AgentController.endTurn()`, un-awaited, with a re-entry flag
- [x] `stillIdle` re-checked after the sample so a new turn cancels the kill (req 4)
- [x] A live sub-agent spawn also counts as attended — it outlives the primary turn and
      drives its own browser (req 4)
- [x] Controller-level tests for the wiring, where the sub-agent gap actually was
- [x] Tests over real process trees, including the unmanaged-browser exclusion and the
      turn-started-mid-sample case
- [x] Threshold chosen from measurement, not guessed — raised 5 → 25 after a real static
      page measured 3
- [x] Verified against the real MCP browser: reclaim, then a working `browser_navigate`
- [x] `npm run lint:dev`, `npm run typecheck`, `npm run test:dev` clean
- [x] Agent-facing note in `src/server/shipit-docs/preview.md`
- [x] planning#614 filed for the in-use browser starving its own container
