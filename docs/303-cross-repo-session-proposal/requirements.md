---
title: Propose work in another repository as a card
description: When the agent proposes a change that belongs in a different repository, the user starts it with one click instead of copying the prompt into a hand-made session.
---

# Propose work in another repository as a card

What the feature must do, in the user's terms. Design lives in `plan.md` once
the open questions below are resolved.

## Requirements

1. When the agent works in one repository and proposes a change that belongs in
   a different repository, it can offer that change to the user as a card in the
   chat transcript.
2. The card says which repository the proposed work is for, and what the work
   is, before the user acts on it.
3. The user starts the proposed work from the card. The user does not copy the
   prompt, does not open the other repository by hand, and does not create a
   session by hand.
4. The work starts as an ordinary ShipIt session on the target repository, with
   the proposed prompt as its first message. The result is the same as the
   result of the manual steps the user does today.
5. The card stays in the transcript and stays usable after the turn ends, like
   every other agent-authored proposal card.

## Open questions

- **Who names the target repository?** The agent has no way to read the user's
  repo list today, so either it gets one, or the card asks the user to pick.
  This also decides what happens when the proposed repository is not registered
  in ShipIt at all.
- **What is the relationship between the two sessions?** A child session (nested
  in the sidebar, and this session can follow it up and hear when it merges), or
  an independent session identical to a hand-made one.
- **Does the click start the work, or fill the composer?** ShipIt's other
  cross-repo start — the Issues tab split button
  ([docs/236-issue-session-repo-picker](../236-issue-session-repo-picker/plan.md))
  — deliberately prefills the composer and makes the user press send, because a
  cross-repo start is reviewed before dispatch. The request here is one click.

## Resolved questions

- (none yet)
