---
title: Autonomous work survives a quota wall — requirements
description: A quota refusal on a turn the agent started itself must not need a human to restart the session.
---

# Autonomous work survives a quota wall

The user's words, from the incident that prompted this: *"as a user I expect
smooth transition across accounts in all cases. I don't even understand the
difference of turn types, and I shouldn't need to."*

1. When a session's credential runs out of quota and another connected
   credential could serve the work, the session continues on that other
   credential — whoever started the turn. The user does nothing.
2. The kind of turn that was interrupted is never visible to the user. A turn
   the agent started by itself behaves the same as one the user sent.
3. When no credential can serve the work, the session stops, and it says so
   without asking the user to send a message.
4. A session stopped that way resumes by itself once one of the user's
   credentials has quota again.
5. A metered API key is still never failed over, and is never told it will be.
6. Continuing must not cost the interrupted turn its work: whatever the agent
   had already written is committed and pushed before anything else starts.

## Open questions

None.

## Resolved questions

- 2026-09-14 — Should the stand-down notice still tell the user to send a
  message? No: ShipIt now sends it. The notice explains what happened and what
  ShipIt is doing, and asks for nothing (req 3).
