---
title: Spawn retry safety — a lost response must not read as "nothing happened"
description: A session create whose response is lost is reported honestly and can be retried without producing a duplicate child.
---

# Spawn retry safety

1. When `shipit session create` fails because the response was lost rather than
   because the request never arrived, it must not report that no session was
   created.
2. Re-running the same `shipit session create` after such a failure must not
   produce a second session.
3. When ShipIt cannot determine whether the session was created, it must say so
   and name how to check, rather than asserting either outcome.
4. Deliberately creating a second session with the same title and prompt must
   remain possible.
5. The other agent-shim commands that share this failure mode must be
   identified, with the cost of a retry stated per command, so the ones worth
   fixing can be chosen rather than all of them changed.
6. When the connection fails after a command's request was sent, ShipIt must
   not send that request again on its own. The one exception is a request that
   carries a key which makes the repeat safe (req 2). This applies to every
   request that is not a read. Reaching ShipIt through its second address when
   the first one is stale must keep working.

## Resolved questions

- 2026-09-14 — *Where is the deduplication key held, and for how long?* The
  approved action left this to the implementer and noted that "a short window is
  enough, since the case it covers is an immediate retry". Held in orchestrator
  memory with a 10-minute TTL, not persisted. The cost of that choice is stated
  in [`plan.md`](./plan.md): an orchestrator restart between the create and the
  retry loses the key, which is why req 3 exists as a separate requirement and
  is not satisfied by req 2 alone.
- 2026-09-14 — *Is the key supplied by the caller or derived from the request?*
  Derived from the request content by the shim. A caller-supplied key cannot
  satisfy req 2: the retry is a fresh `shipit session create` process with no
  memory of the previous invocation's key, so a key it invents is new every
  time. Deriving it from the title, the prompt and the target flags is what
  makes the retry carry the same key without anyone having to remember it.
- 2026-09-14 — *Does req 2 conflict with req 4?* No, because the window is
  short. Two identical spawns more than 10 minutes apart both succeed; two
  within the window collapse into one. The requirement that loses is the
  narrower one — a deliberate identical duplicate inside ten minutes — and it
  stays reachable by varying the title.
- 2026-10-10 — *The retry on the second host name was left open here. Is it to
  be removed?* Yes. The user approved the follow-up of nikzlabs/shipit#3143
  (planning#680): the worker's client must stop sending a request again after
  the request was sent, so that a plugin command or another call that is not
  idempotent cannot run twice, and the fallback for a stale `SHIPIT_HOST` must
  keep working. This is req 6.
