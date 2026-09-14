# Session status card — checklist

Design deliverables (this PR):

- [x] Capture the requirements from the design conversation, with receipts.
- [x] Write the design in plan.md.
- [x] Independent review of the design; fold in the findings.
- [x] Resolve the open question in requirements.md (one nudge attempt; freshness shown on the card, req 14–15).
- [x] Prototype the freshness visual (mockup.html; both states; light and dark).
- [x] Record the chosen visual in plan.md (regular card when current; a small "Stale" label bottom-right when it may be behind; no title text).
- [ ] Record the label color (accent or primary text) once picked from the prototype.

Implementation (a later PR):

- [ ] `session_status` tool, validation module, and the worker relay.
- [ ] Orchestrator route: persist, `session_list` broadcast, turn flag.
- [ ] `sessions.session_status` column, `SessionInfo.sessionStatus`, migration.
- [ ] Per-turn flags on `TurnAccumulator`: `statusUpdated` (route) and `actionsProposed` (propose-actions route).
- [ ] `statusNudge` dispatch option through `prepared-dispatch.ts` and the queue; `silent` and `statusNudge` forwarded into `TurnInput`.
- [ ] Memoized `status-nudge` post-turn step in `turn-executor.ts`; `markSessionStatusStale` on every settled turn without an update.
- [ ] `SessionStatusCard` above the composer, with the "Stale" label bottom-right when it may be behind.
- [ ] Prompt section in `skeleton.md`; composition test.
- [ ] Unit, route, integration and component tests listed in plan.md.
- [ ] Add the tool to all five harness `SHIPIT_MCP_TOOLS` lists.
- [ ] Verify in the dogfood instance: switch away and back, reload, and one turn that skips the tool.
