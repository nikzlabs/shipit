# Checklist — sub-agent lines above the input

- [x] `requirements.md` from the human's words, with receipts
- [x] `deriveSubagentRuns` — both kinds, status, detail, clock, from persisted history
- [x] `SubagentLines` above the composer: one line per running sub-agent, a folded block with failures, no label
- [x] `SubagentRunDialog`: Work / Prompt / Report, consult output with run-on line, time and cost
- [x] In-chat sub-agent cards removed (`visual-elements`, `MessageCards`, `MessageList`, `SubagentCall` deleted)
- [x] Tests ported from the card tests; transcript tests updated
- [x] Sample transcript turn with sub-agents in every state; checked in the dogfood UI (desktop, phone)
- [x] Agent docs and wiki updated
- [x] Quiet-box frame instead of the guide line; "Done" renamed "Finished subagents" (reqs 6, 10)
