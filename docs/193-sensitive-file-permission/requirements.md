---
issue: planning#114
title: Sensitive-file permission prompt — requirements
description: What the approval gate must do for a write outside the workspace and for a call that waits with no answer.
---

# Sensitive-file permission prompt

This feature is older than the requirements rule, so it has no record of the
requirements behind its first design; [plan.md](plan.md) describes that design.
Requirements 1 to 5 come from the incident of 2026-10-12. Their source is the
incident packet that an Ops session wrote on 2026-10-13 after the user asked it
to debug that incident. The words are the Ops session's, not the user's.

Requirements 6 and 7 come from finding I2 of the owner's defect triage of
2026-10-28 (planning#711). Requirement 6 is the owner's request in that finding.
Requirement 7 is the finding's proposed change 3, which the triage scheduled.
The words are the finding's.

1. A location that ShipIt recommends to the agent for its files agrees with the
   approval gate. For `/persist`, one of these is true: the agent's file tools
   write there with no approval card, also through a symlink from the
   workspace, or ShipIt tells the agent that such a write needs the user's
   approval.
2. The agent that owns the turn learns that one of its calls waits for the
   user's approval, when the request stays pending for more than a short time.
   It can then stop the call or change it.
3. ShipIt can tell a request of a subagent from a request of the main agent.
4. ShipIt sets no time limit of its own on the answer of a user who is present.
   This is the property of the first design that the packet says must stay; the
   harness's own timeout is not ShipIt's.
5. ShipIt has a stated proposal for a bound, shorter than the harness's own
   timeout, on a card that a background subagent raised while no user is
   connected. The packet asks to consider this bound and allows a proposal in
   place of an implementation.
6. When a call starts to wait for the user's approval, ShipIt alerts the user by
   the path that a question and a plan use: the voice note, and the voice
   webhook that can reach the user's phone.
7. When a call that waits for the user's approval ends before anyone answers
   it, the agent learns in its next turn that nobody answered and that the call
   did not run.

## Open questions

None.

## Resolved questions

None. No human has answered a question about these requirements. The packet
left each design choice to the fix session, to be stated in the pull request.
