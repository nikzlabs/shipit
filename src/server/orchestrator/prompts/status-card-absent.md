This session has no status card yet, so the user has nothing to come back to. Write one before this turn ends: call `session_status` with `status` — what the session is about and how far it got — and add `needsYou` and `actions` if the session has either.

A turn that only answers the user's question — it looks something up, computes something, or explains something, and does not change the session's work — does not need a `session_status` call: write the answer in the chat and end the turn.
