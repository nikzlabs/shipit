---
issue: planning#375
title: Transcript render cost — requirements
description: The chat UI must stay responsive during a streaming turn, whatever the session's age.
---

# 265 — Transcript render cost: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

## Where these come from

The user reported: *"ShipIt UI hangs every couple of seconds for 1 second"*, and attached a
DevTools trace. The trace (analysed in `planning#375`) confirms the symptom and locates it:
the main thread was blocked for 4.35 s of a 17.6 s recording, in bursts of 1.2 s, 0.65 s and
2.75 s. Requirements 1–4 restate that report as observable statements. Requirements 5–8 are
the existing behaviours that must survive the fix; the user named the first three of them
when approving the work.

## Requirements

1. While the agent is streaming a turn, the chat UI must stay responsive. The user must be
   able to scroll, select text, and type in the composer without the interface stopping.

2. There must be no freeze of the kind reported — a stall of roughly a second, repeating
   every few seconds, for the whole length of a turn.

3. The cost of showing a new streaming update must not grow with the length of the
   conversation. A session with a long history must feel the same as a fresh one.

4. A burst of updates that arrive together must not produce a burst of separate stalls.

5. The transcript must stay pinned to the bottom while a message is being written, exactly
   as it does today.

6. Selecting text in the transcript, and the "Reply" quote button that appears on a
   selection, must keep working.

7. In-app search must keep working: a jump to a match must scroll to that match and
   highlight it, including a match far above the visible area.

8. The chat history must be fetched once per attach. A load that is superseded must be
   cancelled, not merely ignored after it has been downloaded.
   *(Delivered — see `plan.md`.)*

## Open questions

- **Q1. Must the whole conversation stay present in the page?** The cheapest way to meet
  requirement 3 is to keep only the visible part of the transcript rendered ("windowing").
  That has a cost the user would notice: the browser's own Ctrl+F would find only what is
  currently on screen, and "select all → copy" would copy only that part. The alternative —
  keeping every message in the page but skipping the work for messages that did not change —
  preserves both, and the trace says it is very probably sufficient. It is, however, weaker
  in the limit: memory and first-open cost still grow with the conversation.

- **Q2. Should the client stop loading the entire history at once?** Today the client fetches
  the whole conversation on attach; in the traced session that was 2.67 MB. Loading only the
  recent part, with older messages fetched on demand, would cut the first-open cost and the
  transfer. This is a change to what the user sees (older messages appear when asked for),
  so it is not the agent's to decide.

## Resolved questions

*(none yet)*
