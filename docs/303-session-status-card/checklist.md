# Session status card — checklist

Implementation of [plan.md](plan.md); the design deliverables shipped in the
docs-only PR and their review history is on planning#550.

- [x] `advanced.sessionStatusCard` in the settings catalogue, off by default; save hook marks stored cards stale on false → true.
- [x] Flag on the per-turn run params → `SHIPIT_SESSION_STATUS_CARD` in the spawn env, `writeMcpConfig` context, the five adapter tool lists, Claude's allowlists; resident reuse check against the flag.
- [x] `session_status` tool and its bridge registry entry; `validateActionItems` extracted and shared; envelope validation with every field optional (a bare call confirms); worker relay.
- [x] Orchestrator route: validate, merge the delta, provenance, reconcile offers, persist, broadcast, `statusUpdated`, reply with the offered list; refuse a bare call with no stored card. `propose_actions` route refuses under the flag.
- [x] `sessions.session_status` column and `SessionInfo.sessionStatus`; `recordSessionStatus`, `markSessionStatusStale(ifWriteSeq)`, `takeOfferedActions`, `runStatusExclusive`.
- [x] `statusUpdated` on `TurnAccumulator`.
- [ ] `settleTurnFacts` on all four terminal paths before the drain, with the immediate guarded stale mark; reset on adoption; memoized decision after idle; dispatch from `finishTurn` via the drain entry.
- [ ] `statusNudge` and `silent` through `AgentDispatchInit`, `QueuedMessage`, `toQueuedMessage`, `queuedMessageToDispatchOptions`, `TurnInput`.
- [ ] Lifecycle: stale on rewind/reset; copy-as-stale on fork.
- [x] `checklistAccepted` takes offers by `offerId` after admission; busy-path ordering fix.
- [x] Split `ActionChecklistCard` into the shared checklist and two wrappers; per-offer provenance in the status card's submit message.
- [x] `SessionStatusCard` as the last child of the message list's content element, scrolling with the conversation: two fields, offers with one Send, taken offers greyed and disabled, "Stale" label bottom-right.
- [x] Prompt: two variants at module load; the flag-on section, in the injected system prompt, replaces the follow-up-actions section, keeps its §5 boundary and says to call the tool bare when nothing changed; composition tests per variant.
- [ ] Tests listed in plan.md, including the flag-off byte-for-byte checks per harness.
- [ ] Verify in the dogfood instance: flag on — switch away and back, reload, a turn that skips the tool, a resident agent across a toggle; flag off — an action card as today.
