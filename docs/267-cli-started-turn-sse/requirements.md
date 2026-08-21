# Requirements — a CLI-started turn announces itself on the global SSE

Source: the incident packet from the ops session that diagnosed this on the
production host (deployed commit `093f2fac1e92`), plus the user report it came
from. Numbered, observable statements of what must be true; the mechanism lives
in [`plan.md`](./plan.md).

1. When a session's agent is working, every open sidebar shows that session as
   working — including sidebars that are not viewing that session.
2. Requirement 1 holds for a turn ShipIt did not start, not only for a turn
   started from the chat box. A background job reporting back (a returning
   `shipit agent run` consult, a `Bash(run_in_background)` job) is the ordinary
   way this happens.
3. The sidebar never shows the green "CI passed" checkmark for a session whose
   agent is working. Working outranks CI state.
4. The user does not have to switch into a session to see the truth about it.
5. When such a turn ends, the sidebar stops showing that session as working. A
   session is never left reading as working after its agent has stopped.
6. One such turn is announced once, however many background jobs report back
   while it runs.
7. A background job reporting back while the session's own turn is still running
   is not a new turn and changes nothing the user sees.

## Open questions

None.

## Resolved questions

None — the packet answered the scope questions in full, and the remaining
decisions (which SSE payload fields to send, where the announcement lives) are
mechanism, recorded in `plan.md` rather than here.
