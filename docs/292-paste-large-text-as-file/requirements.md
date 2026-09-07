---
issue: planning#517
title: A large paste becomes a file attachment, not input text
description: Pasting more than 2,000 characters into the chat input uploads the text as a .txt attachment instead of filling the composer with it.
---

# A large paste becomes a file attachment, not input text

Pasting a large block of text into the chat input fills the composer with thousands of
characters. The box becomes unreadable, the text is hard to edit around, and the paste is
sent inline in the message.

1. Pasting text of **2,000 characters or more** into the chat input does **not** put the
   text into the input box.
2. That paste is instead attached to the message as an **uploaded text file**, using the
   same attachment mechanism as a file the user uploads by hand.
3. A paste **below** 2,000 characters behaves exactly as it does today — it goes into the
   input box as text.
4. The attachment appears in the composer before the message is sent, and can be removed
   the same way any other upload can.
5. There is **no** way to put a converted paste back into the input as text. Over the
   threshold, a paste is always a file.

## Non-requirements

- Nothing changes for pasting an **image** — that path already exists and is untouched.
- Nothing changes for a **file drag-and-drop** or the `@`-mention file-context path.
- The threshold is not user-configurable.

## Requirement provenance

Reqs 1 and 5 carry the human's answers (below). Req 2 is the request's own words ("uploaded
as a text file attachment"). Reqs 3 and 4 are what req 1 needs in order to be true rather
than separate asks: a rule that converts *large* pastes says small ones are unchanged, and
an attachment the user cannot see or remove is not an attachment.

## Open questions

- None.

## Resolved questions

- **2026-09-07 — What counts as a "big" paste?** Answer: **2,000 characters.** Roughly 30–50
  lines of code or a medium log dump; below that the paste stays inline. A line-count
  trigger and a larger 10,000-character threshold were both offered and not chosen.

- **2026-09-07 — Should the user be able to put a converted paste back as plain text?**
  Answer: **no.** Over the threshold a paste always becomes a file. An undo (Ctrl+Z right
  after the paste, or a "paste as text" control on the chip) was offered and declined in
  favour of the simpler rule.
