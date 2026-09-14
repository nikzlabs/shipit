# Session status card — checklist

Design deliverables (this PR):

- [x] Capture the requirements from the design conversation, with receipts.
- [x] Write the design in plan.md.
- [ ] Independent review of the design; fold in the findings.

Implementation (a later PR):

- [ ] `session_status` tool, validation module, and the worker relay.
- [ ] Orchestrator route: persist, `session_list` broadcast, turn flag.
- [ ] `sessions.session_status` column, `SessionInfo.sessionStatus`, migration.
- [ ] Per-turn flags on `TurnAccumulator`; `questionAsked` at the interrupt; `actionsProposed` in the propose-actions route.
- [ ] `decideStatusNudge` and the `idle` listener that dispatches the nudge turn; one nudge per turn.
- [ ] `SessionStatusCard` above the composer; stale marker after a failed nudge.
- [ ] Prompt section in `skeleton.md`; composition test.
- [ ] Unit, route, integration and component tests listed in plan.md.
- [ ] Add the tool to all five harness `SHIPIT_MCP_TOOLS` lists.
- [ ] Verify in the dogfood instance: switch away and back, reload, and one turn that skips the tool.
