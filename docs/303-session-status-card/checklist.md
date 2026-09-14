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
- [x] Second independent review (after the merge); fold in the findings: snapshot-and-version guard, server-owned offer identity, no alias, acceptance-path removal, shared item validator.

Implementation (a later PR):

- [ ] `session_status` tool (status, needsYou, actions, replaceActions); `validateActionItems` extracted and shared; envelope validation; the worker relay.
- [ ] Orchestrator route: persist, `session_list` broadcast, turn flag.
- [ ] `sessions.session_status` column (status, needsYou, offers with `offerId`, fresh, version, provenance), `SessionInfo.sessionStatus`, migration; `runStatusExclusive`.
- [ ] Per-turn flag `statusUpdated` on `TurnAccumulator`, set by the session-status route.
- [ ] Evolve the action card: remove `propose_actions` (tool, route, bridge entry, adapter lists, prompt section); split `ActionChecklistCard` into the shared checklist and two wrappers; `checklistAccepted` takes offers by `offerId` on acceptance.
- [ ] `statusNudge` dispatch option through `prepared-dispatch.ts` and the queue; `silent` and `statusNudge` forwarded into `TurnInput`.
- [ ] Memoized `status-nudge` post-turn step in `turn-executor.ts` on a pre-drain snapshot; version-guarded `markSessionStatusStale` on every settled turn without an update.
- [ ] Lifecycle: stale on rewind/reset; copy-as-stale on fork.
- [ ] `SessionStatusCard` above the composer: two fields, the offered actions with one Send, the "Stale" label bottom-right when it may be behind.
- [ ] Prompt section in `skeleton.md` replacing the `propose_actions` section; composition test.
- [ ] Unit, route, integration and component tests listed in plan.md.
- [ ] Add the tool to all five harness `SHIPIT_MCP_TOOLS` lists.
- [ ] Verify in the dogfood instance: switch away and back, reload, and one turn that skips the tool.
