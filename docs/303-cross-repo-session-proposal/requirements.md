---
issue: planning#551
title: Propose work in another repository as a card
description: When the agent proposes a change that belongs in a different repository, the user starts it with one click instead of copying the prompt into a hand-made session.
---

# Propose work in another repository as a card

What the feature must do, in the user's terms. Design lives in
[`plan.md`](plan.md).

## Requirements

1. When the agent works in one repository and proposes a change that belongs in
   a different repository, it can offer that change to the user as a card in the
   chat transcript.
2. The card says which repository the proposed work is for, and what the work
   is, before the user acts on it.
3. The user starts the proposed work from the card. The user does not copy the
   prompt, does not open the other repository by hand, and does not create a
   session by hand.
4. One click starts the session and sends the prompt. The agent in the target
   repository begins work immediately; the user does not press send.
5. The work starts as an ordinary ShipIt session on the target repository, with
   the proposed prompt as its first message. The result is the same as the
   result of the manual steps the user does today.
6. The new session is independent of the session that proposed it. It is not a
   child session and it does not nest in the sidebar, because a nested session
   reads as belonging to its parent's repository and this one does not.
7. The agent names the target repository itself, from the conversation it is
   already having. The user does not choose the repository as a step of starting
   the work, and ShipIt adds no agent-facing API for reading the repository
   list.
8. The proposed repository is reached with the GitHub token the user already
   gave ShipIt. A repository that token can reach is a valid target whether or
   not it is already registered in ShipIt.
9. The card stays in the transcript after the turn ends and after a page reload,
   like every other agent-authored card. After the work starts, the card names
   the session it started and opens it.

## Open questions

None.

## Resolved questions

- 2026-09-14 — *Who names the target repository?* The user answered that the
  agent names it: the conversation is already about a specific repository, and
  the GitHub token the user gave ShipIt already reaches all of their
  repositories, so no new repository-listing API is justified (reqs 7, 8).
- 2026-09-14 — *Is the new session a child of the proposing session?* The user
  answered independent. The reason is UX, not mechanism: a nested session in the
  sidebar visually belongs to its parent's repository group, so a nested
  cross-repository session would be filed under the wrong repository (req 6).
- 2026-09-14 — *Does the click start the work or fill the composer?* The user
  chose start and send, over the composer-prefill behaviour the Issues tab uses
  for its cross-repository start (req 4).
