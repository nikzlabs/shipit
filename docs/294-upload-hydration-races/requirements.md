---
issue: planning#519
title: An out-of-date upload listing never overwrites what is true
description: Upload hydration ignores a stale or foreign listing and refetches, and /compact stops discarding the composer's attachments.
---

# An out-of-date upload listing never overwrites what is true

Three silent losses, found by review while building
[docs/293-send-with-attachments](../293-send-with-attachments/requirements.md)
and recorded there as non-requirements. All three predate that work. What they
share is that nothing tells the user: an attachment is simply not there any more.

## The uploads panel is rebuilt from a listing

1. A listing that is **out of date** — an upload landed, or a file was deleted,
   while it was in flight — is not applied. A fresh listing is fetched in its
   place, so the panel still ends up correct.
2. A listing that belongs to a **different session** than the one on screen is
   not applied at all.
3. A listing that has been **superseded** by a newer one for the same session is
   not applied, and does not trigger a refetch of its own — the newer one is
   already doing that work.
4. No attachment loses its place in the composer because of 1–3. An attachment
   the user has not sent is still there after a reload.

## `/compact` is a command, not a message

5. Sending `/compact` with an attachment in the composer leaves the attachment
   **in the composer**, ready for the user's next message.
6. `/compact` carries no attachment to the agent.

## Non-requirements

- Nothing changes about what `/compact` does to the conversation, on either the
  mid-turn path (`agent.compact()`) or the fresh-turn path.
- No retry policy beyond req 1's single refetch. A listing that is out of date
  *again* is handled by the same rule, bounded so a churning session cannot spin
  the server.
- The uploads panel is not made to update live. It is still rebuilt on the
  existing triggers (connect, session switch, Refresh) — this is about those
  rebuilds being correct, not more frequent.

## Requirement provenance

Reqs 1 and 5 carry the human's answers (below). Req 2 is not a separate ask: a
response applied to the wrong session is the same defect as a response applied at
the wrong time, and the client already guards its other hydration this way
(CLAUDE.md, *Client communication & stores*). Req 3 is what req 1 needs in order
to be bounded — without it, "fetch a fresh one" is a rule that can chase itself.
Req 4 states the goal the first three serve. Req 6 is what req 5 needs to be
coherent: an attachment cannot both stay in the composer and be sent.

## Open questions

- None.

## Resolved questions

- **2026-09-07 — What should happen to an upload listing that comes back out of
  date?** Answer: **drop it and fetch a fresh one**, so the panel ends up correct
  within a moment. The alternative offered — drop it and let the panel catch up on
  the next reconnect, session switch or Refresh — was not chosen.

- **2026-09-07 — You attach a file, then send `/compact` while a turn is running.
  Today the attachment vanishes with no message. What should it do?** Answer:
  **keep it in the composer** for the next real message. The alternative offered —
  record it in the transcript alongside the compaction, matching what `/compact`
  does when no turn is running — was not chosen, on the grounds that `/compact`
  is a control command with no use for an attachment.
