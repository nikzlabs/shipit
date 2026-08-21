---
issue: planning#346
title: Send-review dialog with a free-text note
description: A confirmation step before review comments go to the agent, carrying a free-text note for context that belongs to no single line.
---

# 260 — Send-review dialog: requirements

The interactive prototype is [`mockup.html`](./mockup.html). No design document exists yet.

Today the **Send comments** button submits the review draft immediately. Some feedback belongs to no single line — an overall summary, a constraint, the reason for the review — and there is nowhere to put it.

1. When the user sends a review, ShipIt shows a dialog before the review goes to the agent.

2. The dialog says how many comments will be sent, and what they are on: the file for a single-file review, or the number of files for a diff review.

3. The dialog does not list the comments. The user reads the comments in the file they came from.

4. The dialog has one free-text field, for information that the comments do not carry.

5. The free-text note is optional. The user can send the review with an empty note.

6. The note becomes the first piece of feedback in the message that the agent gets: after the line that says which file was reviewed, and before the anchored comments. The instruction to address the feedback stays at the end of the message.

7. The note is kept with the sent review. When the user opens **Past reviews**, each review shows the note that was sent with it.

8. The dialog always opens. There is no key or modifier that sends the review directly.

9. The dialog is the same on all surfaces that send review comments: the file-viewer dialog, the Present tab, and the diff panel.

10. The user can cancel the dialog. The draft comments stay in the draft, and the note is not lost while the dialog is open.

## Later versions

- The dialog lists the comments and lets the user remove a comment from it. Deliberately not in this version: it is more machinery than the first version needs, and the value is not proven yet.

## Resolved questions

- 2026-08-10 — Does the note go at the top of the message or at the bottom, after the comments? Nik asked for a recommendation and approved this one: the top. A note is either a summary, which belongs before what it summarizes, or the one comment that fits no line, which has no other natural position. The bottom would also put the note between the comments and the closing instruction, or after it. Requirement 6 records the position.
- 2026-08-10 — Is the note kept with the sent review, so that it shows in "Past reviews"? Nik: yes. Requirement 7.
- 2026-08-10 — Can the user skip the dialog with a modifier key, for example ⇧⏎ on the Send button? Nik: not for now. Requirement 8.
- 2026-08-10 — Does the dialog list the comments, and can the user remove a comment from it? Nik: not in the first version — the count and the note are sufficient, and the rest can come later. Requirements 2 and 3; the removed part is under "Later versions".
- 2026-08-10 — The first prototype marked comments written by the review subagent. Nik: that cannot happen — a subagent sends a review as one blob of text, never as comments. The `source: "human" | "ai"` discriminator is dead code from the removed `submit_review_comments` path (docs/203, docs/220), and its removal is separate work, not part of this feature.
