# Session status card — checklist

Implementation of [plan.md](plan.md); the design deliverables shipped in the
docs-only PR and their review history is on planning#550.

- [x] `advanced.sessionStatusCard` in the settings catalogue, off by default; save hook marks stored cards stale on false → true.
- [x] Flag on the per-turn run params → `SHIPIT_SESSION_STATUS_CARD` in the spawn env, `writeMcpConfig` context, the five adapter tool lists, Claude's allowlists; resident reuse check against the flag.
- [x] `session_status` tool and its bridge registry entry; `validateActionItems` extracted and shared; envelope validation with every field optional (a bare call confirms); worker relay.
- [x] Orchestrator route: validate, merge the delta, provenance, reconcile offers, persist, broadcast, `statusUpdated`, reply with the offered list; refuse a bare call with no stored card. `propose_actions` route refuses under the flag.
- [x] `sessions.session_status` column and `SessionInfo.sessionStatus`; `recordSessionStatus`, `markSessionStatusStale(ifWriteSeq)`, `takeOfferedActions`, `runStatusExclusive`.
- [x] `statusUpdated` on `TurnAccumulator`.
- [x] `settleTurnFacts` on all four terminal paths before the drain, with the immediate guarded stale mark; reset on adoption; memoized decision after idle; dispatch from `finishTurn` via the drain entry.
- [x] `statusNudge` and `silent` through `AgentDispatchInit`, `QueuedMessage`, `toQueuedMessage`, `queuedMessageToDispatchOptions`, `TurnInput`.
- [x] Lifecycle: stale on rewind/reset; copy-as-stale on fork.
- [x] `checklistAccepted` takes offers by `offerId` after admission; busy-path ordering fix.
- [x] Split `ActionChecklistCard` into the shared checklist and two wrappers; per-offer provenance in the status card's submit message.
- [x] `SessionStatusCard` as the last child of the message list's content element, scrolling with the conversation: two fields, offers with one Submit, taken offers greyed, tagged SENT and still tickable, "Stale" label bottom-right.
- [x] Prompt: two variants at module load; the flag-on section, in the injected system prompt, replaces the follow-up-actions section, keeps its §5 boundary and says to call the tool bare when nothing changed; composition tests per variant.
- [x] Tests listed in plan.md, including the flag-off byte-for-byte checks per harness.
- [x] Req 30: the card keeps its turn-start place while a turn runs and returns to the end when it stops — frozen anchor, one keyed list so the move is not a remount, a group keyed by the chunk it belongs to, and the reading anchor restored under the card's own scroll guard.
- [x] Verify req 30 by hand in the dogfood instance on a narrow viewport: a seeded card, a real turn, the card scrolling away and coming back.
- [x] Req 31: `lastTurn` through the domain type, the validator, the service merge as the one non-delta field, the row parsing, the tool schema, the route reply, the injected prompt and the nudge prompt; the card renders it first, labelled beside a labelled status, and hides it when stale.
- [x] Req 32: `pending-answer.ts`; every answer card in a container keyed by its tool, the pending one last in the flow under the status card; the chunk piece counter that replaces `openedByCard`, with the chunk tracked rather than recomputed.
- [x] Verify both by hand in the dogfood instance at 390x780: a turn ending with a question, with a card and offers present, and a card whose last-turn line changes.
- [x] Verify in the dogfood instance: flag on — switch away and back, reload, a turn that skips the tool, a resident agent across a toggle; flag off — an action card as today.
- [x] Req 33: three capped, accent-tinted cards — Status, Next steps, Last turn — with the Stale mark in the status cap; the unticked checkbox given a surface of its own so it survives the tint; `mockup.html` redrawn as the shipped look, with every drawn round kept beside it; reqs 14, 28 and 31 amended.
- [x] Verify req 33 by hand in the dogfood instance, wide and at 390x780, fresh and stale, in a light and a dark theme.
- [x] Req 33, second pass: two tones — soft caps on Status and Last turn, the filled cap on Next steps, which moves last; the Stale mark redrawn in the accent for the now-soft status cap.
- [x] Verify the two tones by hand in the dogfood instance, including the empty case: with no manual step and no offer the whole "Next steps" card is absent, leaving the two soft cards.
- [x] Req 33, third pass: a third tone — Last turn leaves the accent for the ordinary card surface, after an inventory showed `--color-info` equals `--color-accent` in three themes and `--color-pr` means "pull request"; `look-lastturn.html` keeps the four candidates.
- [x] Req 35 (planning#591): the stored card rides every turn's prompt — `formatSessionStatusContext` and its 8000-char cap, `sessionStatusTurnContext` behind the setting, the prefix in both composition sites, `SystemTurnDeps.sessionStatusContext`; the nudge prompt rewritten to carry the same block and ask for a line-by-line reconciliation; the injected section told to reconcile against the block rather than from memory.
- [x] Req 34 (planning#589): a turn a message reached after it started is not nudged — `steered` and `promptQueued`, both snapshotted in `settleTurnFacts`, join `running` and the queue as pending successors, so a message is never preempted by a system turn that retires the process holding it.
- [x] Req 36 (planning#594): the settlement asks what the turn DID, not who started it — `harnessCommand` replaces the `silent` exemption in both the nudge and the stale mark, so a compaction the user asks for is exempt alongside the one ShipIt starts; scoped to the turn being settled so a CLI-started successor cannot inherit it, and withheld when the command arrives wrapped as another session's message. Every other ShipIt-started turn stays checked, each walked against the rule and tabulated in plan.md.
- [x] planning#595: opening a session lands at the end of its conversation — the follow-the-bottom and gesture refs in `useMessageScroll` reset on the displayed session, because the card is the whole of the content in the loading gap and removes the clamp the open path was relying on for its repair; guarded on the real list through the whole open sequence.
