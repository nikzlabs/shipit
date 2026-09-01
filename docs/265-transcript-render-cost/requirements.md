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

Requirement 13 comes from a **second** report, on 2026-09-01: *"ShipIt burns ~25% of a CPU
core on a session where nothing is happening."* It is the same finding this folder's
`checklist.md` had already recorded and deliberately left unfixed, now reproduced a third
time and complained about by a user.

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

9. Every message stays present in the page. The browser's own Ctrl+F, and "select all →
   copy", must keep covering the whole conversation, not only the visible part.

10. Switching away from a session and back must not download the conversation again. The
    user moves between sessions constantly, and each move currently costs megabytes.

11. A transcript shown from a cache must not be stale. What the user sees after switching
    back must match what the server holds.

12. The file tree must not be re-sent as part of the chat-history response when it has not
    changed. It is 325 KB of this repository's payload and is unrelated to the transcript.

13. A session where nothing is happening must not keep the processor busy. With no turn
    running, no typing and no network traffic, the page must cost close to nothing — however
    long the conversation is, and whatever the page is showing.

## Open questions

*(none)*

## Resolved questions

- **2026-08-15 — Must the whole conversation stay present in the page?** Asked because the
  cheapest way to meet requirement 3 is to render only the visible part ("windowing"), which
  would cost the user the browser's own Ctrl+F and select-all across the whole conversation.
  **The user chose to keep every message mounted** and instead skip the render work for
  messages that did not change. Added as requirement 9; requirement 3 stands and is met by
  making the *per-update* cost proportional to what changed rather than to the conversation.

- **2026-08-15 — Should the client stop loading the entire history at once?** Asked because
  the traced session downloaded 2.67 MB on attach. **The user chose to keep loading it all**,
  and asked for a cache so that switching back and forth does not re-download it. Added as
  requirements 10 and 11. Paginated history is not being built.

  The user also asked why the payload is so heavy. Measured for this repository: the
  recursive workspace file tree in the same response is **325 KB** (2,847 files, 505
  directories), the git log is capped at 50 commits, and tool inputs/results are already
  clamped and images already replaced by URLs before serving (docs/244). The remaining
  ~2.3 MB is the conversation itself. So the payload is heavy because the conversation is
  long — with one avoidable passenger, the file tree, which has nothing to do with chat
  history and is re-sent on every attach. That became requirement 12.
