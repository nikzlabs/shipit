---
issue: planning#518
title: Send never loses an attachment, and can carry attachments alone
description: The composer refuses to send while an attachment is still uploading or has failed, and a message made only of attachments can be sent.
---

# Send never loses an attachment, and can carry attachments alone

Two defects on the same surface — what the composer's Send does about attachments.
Found by review while building [docs/292-paste-large-text-as-file](../292-paste-large-text-as-file/requirements.md);
both predate it and affect pasted images and drag-dropped files identically, but a
converted paste is the case where the clipboard is the user's only other copy.

## Never lose an attachment

1. While **any** attachment on the message is still uploading, the message cannot
   be sent. Send is visibly unavailable and says why.
2. While **any** attachment on the message has failed to upload, the message
   cannot be sent. Send is visibly unavailable and says why. The user clears the
   block by retrying the attachment or removing it.
3. **Retry** on a failed attachment re-uploads it. It does not remove it.
4. A message that is sent carries every attachment shown in the composer at the
   moment of sending. No attachment is dropped without the user being told.

## Send attachments alone

5. A message consisting only of attachments — no typed text — can be sent.
6. A message with neither text nor attachments still cannot be sent.

## Non-requirements

- **The quick-capture overlay still closes before its send resolves.** That is
  `docs/205`'s deliberate optimistic start — the user is not held behind a modal
  spinner during a session boot, and a failure surfaces as a toast
  (`startQuickSessionInBackground`, `stores/actions/session-actions.ts`). The
  review that raised these defects listed it as a third one; it is a shipped
  design decision, not a defect, and reversing it is its own question.
- Nothing changes about *when* a composer is dead as a whole (`disabledReason`,
  `docs/257`) or about Send waiting for the workspace on a new-session view
  (`docs/291`). Those bars already exist and keep their own reasons.
- No retry is automatic. Req 3 is the button doing what it says, not a
  background retry policy.

## Requirement provenance

Reqs 1, 2 and 5 carry the human's answers (below). Req 3 is not a separate ask:
answer 2 makes a failed attachment block the message, so a "Retry" that deletes
the attachment would clear the block by silently discarding the thing the block
exists to protect. Req 4 states the goal the other requirements serve. Req 6 is
what req 5 needs in order to be bounded rather than a separate ask.

## Open questions

- None.

## Resolved questions

- **2026-09-07 — Pressing Send while an attachment is still uploading drops it
  silently. What should Send do instead?** Answer: **grey out Send until the
  upload finishes**, with a tooltip saying why. Same shape as the network-mode
  barrier already in this composer, so no pending-send state, no cancel path and
  no timeout. The alternative offered — Send waits and then goes on its own — was
  not chosen.

- **2026-09-07 — And when an attachment has already failed to upload?** Answer:
  **block Send until the user retries or removes it.** The alternative offered —
  send the rest and keep the failed chip visible — was not chosen, so a failed
  attachment holds the message rather than being left behind.

- **2026-09-07 — A message with attachments but no typed text cannot be sent at
  all. Change that?** Answer: **yes — attachments alone can be sent.** The agent
  receives the attachment content with no instruction, as in any chat app where a
  file can be sent on its own.
