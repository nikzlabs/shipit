---
issue: planning#719
title: Code Mode setting per harness — requirements
description: A ShipIt setting, one per harness that has a Code Mode, that turns the harness's Code Mode on or off.
---

# Code Mode setting per harness — requirements

"Code Mode" is a harness feature: the agent writes a short JavaScript
program that calls its tools (MCP tools above all), instead of calling each
tool directly. It saves model round-trips and tokens, but the transcript shows
one code card instead of one card per tool call.

Sources: the user's words of 2026-11-10, passed on by the parent session
"OpenCode 2: Claude sign-in, steering, tool-card images".

## Requirements

1. **Efficiency over chat cards.** Whether Code Mode is on is decided by how
   efficiently the agent works, not by how many tool cards the chat shows.
   Hiding tool calls inside one code card is not a reason to turn it off.
2. **A setting per harness.** The Settings dialog has a control that turns
   Code Mode on or off, one per harness that has a Code Mode that can run in
   ShipIt. A harness without one gets no control.
3. **A useful card.** When Code Mode runs, its tool card shows the code it
   ran, its result, and any images the tools inside it returned.

## Open questions

- What is each harness's default: OpenCode 2, Codex (its Code Mode is
  marked "under development" upstream), and OpenCode 1 (experimental flag)?
- Does OpenCode 1 get a control at all?
- Does a change apply from the next turn of a session that is already
  running, or only to new sessions?

## Resolved questions

- **2026-11-10 — ShipIt turned OpenCode 2's Code Mode off because it "would
  hide edits from the transcript". Is that the right reason?** The user: "well
  I didn't approve this reason. We need to aim for better agent efficiency,
  not for chat messages." (req 1)
- **2026-11-10 — Only turn Code Mode on for OpenCode 2, or make it a
  setting?** The user: "ideally I want a setting in the UI to enable/disable
  code mode, per harness" (req 2).
