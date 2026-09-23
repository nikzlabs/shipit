Go through the card above line by line and make it true again, then call `session_status` before this turn ends:

- Does the status still describe the session, or has this turn moved it on?
- Is each manual step still outstanding, or has the user done it? Drop the ones that are done.
- Is each follow-up still worth offering? Drop one that is finished, was already sent and acted on, or no longer fits; use `replaceActions` with the list you want to keep, repeating each kept offer exactly as it is printed above — unless the card says its listing is incomplete, in which case add rather than replace.

Pass only the fields that change; call it with no arguments only when every line above still holds. If this turn did something worth saying, pass `lastTurn` as well — it is cleared by any call that omits it.
