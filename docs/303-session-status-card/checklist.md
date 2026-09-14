# Session status card — checklist

Design deliverables (this PR):

- [x] Capture the requirements from the design conversation, with receipts.
- [x] Write the design in plan.md.
- [x] Independent review of the design; fold in the findings.
- [x] Resolve the open question in requirements.md (one nudge attempt; freshness shown on the card, req 14–15).
- [x] Prototype the freshness visual (mockup.html; both states; light and dark).
- [x] Record the chosen visual in plan.md (regular card when current; a small "Stale" label bottom-right when it may be behind; no title text).
- [x] Record the label color: the theme accent (`--color-accent`).
- [x] Fold the follow-up action card into the status card (reqs 16–20); redraw the mockup with actions.

Implementation (a later PR):

- [ ] `session_status` tool (status, needsYou, actions, replaceActions), validation module reusing the action-item validator, and the worker relay.
- [ ] Orchestrator route: persist, `session_list` broadcast, turn flag.
- [ ] `sessions.session_status` column, `SessionInfo.sessionStatus`, migration.
- [ ] Per-turn flag `statusUpdated` on `TurnAccumulator`, set by the session-status route.
- [ ] Evolve the action card: `propose_actions` becomes an alias that merges actions; the route stops emitting transcript cards; `ActionChecklistCard` splits into the shared checklist piece and the history wrapper; submit from the pinned card removes the ticked ids.
- [ ] `statusNudge` dispatch option through `prepared-dispatch.ts` and the queue; `silent` and `statusNudge` forwarded into `TurnInput`.
- [ ] Memoized `status-nudge` post-turn step in `turn-executor.ts`; `markSessionStatusStale` on every settled turn without an update.
- [ ] `SessionStatusCard` above the composer: two fields, the offered actions with one Send, the "Stale" label bottom-right when it may be behind.
- [ ] Prompt section in `skeleton.md` replacing the `propose_actions` section; composition test.
- [ ] Unit, route, integration and component tests listed in plan.md.
- [ ] Add the tool to all five harness `SHIPIT_MCP_TOOLS` lists.
- [ ] Verify in the dogfood instance: switch away and back, reload, and one turn that skips the tool.
