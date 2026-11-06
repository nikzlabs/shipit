# Sub-agent lines above the input

Design: [`plan.md`](./plan.md). Visual reference: [`mockup.html`](./mockup.html)
(the "Quiet box" style, req 10).

## Requirements

1. Sub-agents are shown in one fixed place, right above the chat input, in a
   compact view.
2. It covers both kinds of sub-agent: the agent's own sub-agents (Claude's
   Agent tool) and ShipIt sub-agents (`shipit agent run`).
3. Child sessions (`shipit session create`) are not shown there.
4. There is no "Agents" label.
5. Each running sub-agent has a line of its own.
6. Finished sub-agents are collapsed into one expandable block labelled
   "Finished subagents".
7. At a glance, the user can tell which sub-agents are active and how many
   were run.
8. The sub-agent cards in the chat are removed. The chat does not show where
   a sub-agent ran.
9. Clicking a sub-agent's line opens a full dialog window with that
   sub-agent's whole work, not a small panel.
10. The lines sit in a quiet box: a faint frame around them, the mockup's
    "Quiet box" style.
11. The "Finished subagents" line does not count failures. A failed sub-agent
    is marked only inside the opened list.

## Open questions

None.

## Resolved questions

- 2026-11-05 — What should the area look like? Nik asked for "UI for showing
  native subagents and shipit subagents right above the input field, fixed
  place, compact view" (reqs 1–2). Shown three options, Nik chose: "let's
  explore option A, but one line per agent, with no "Agents" word" (reqs 4–5).
- 2026-11-05 — Should child sessions be shown? Nik: "no" (req 3).
- 2026-11-05 — When do finished sub-agents clear? Nik: "let's collapse them in
  the "done" expandable block" (req 6).
- 2026-11-05 — Do the chat cards stay? Nik: "the existing cards would be
  removed" (req 8).
- 2026-11-05 — Does the chat need to show where a sub-agent ran? Nik: "I'm not
  sure if it is important. For me way more important is to know what agents are
  active and how many were run" (reqs 7–8). Recorded as: no marker in the chat.
- 2026-11-05 — What does clicking a line open? Nik: "lets make it open the full
  dialog window, I don't see why we need to fit the whole agent work into a
  small panel" (req 9).
- 2026-11-05 — Nik approved building it from the mockup (guide-line style,
  states a–h). The mockup's details — what a line shows, the red failure count
  on that line, the block keeping the whole session's sub-agents, newest first —
  are the agent's design, approved as a whole by that selection rather than
  stated one by one.
- 2026-11-06 — After the first version merged, Nik: "I want the "Quiet box" UI
  option. "Done" should be "Finished subagents", otherwise it is not clear what
  this panel is about." This replaces the guide-line style (req 10) and the
  "Done" label (req 6).
- 2026-11-06 — Nik noticed the red failure count builds up over a long session
  ("Finished subagents · 16 · 1 failed"). Offered a count for the latest turn
  only, a count until seen, or no count, Nik chose no count: "This is not
  actionable anyway, it is more for rare debugging cases" (req 11).
