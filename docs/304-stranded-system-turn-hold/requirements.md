---
issue: planning#552
title: A stranded system-turn hold
description: What ShipIt must do when a CLI-started turn is adopted over a non-streaming system turn.
---

# A stranded system-turn hold

Written from the ops packet that diagnosed session `ed7d9efe` on 2026-09-14
against deployed build `b8ecfa69a02a`.

1. A session that ran a ShipIt-started system turn must be able to start another
   turn afterwards, including when the agent CLI reported a turn of its own
   (a finished `Bash(run_in_background)` job) between that turn's result and its
   exit. Nothing may need an orchestrator restart to recover.
2. A message sent, queued or dispatched after such a turn must run, whether it
   comes from the user, from a merged child PR, from a child session's report, or
   from a finished background consult — including one that arrives while the turn
   is between its result and its exit.
3. A hold that belongs to something else — a driver that owns the session
   between turns, or a later turn — must not be released by the turn that was
   displaced.
4. A caller that wakes a session must be able to tell whether its wake started a
   turn or is waiting in the queue, and must report which of the two happened.
5. A dispatch that is queued rather than started must say so in the logs, with
   the reason it was not admitted.

## Open questions

None.

## Resolved questions

- 2026-09-14 — Which repair for requirement 1: clear the hold where the adoption
  happens, or relax `finishTurn`'s epoch guard? The ops packet asked for both to
  be weighed and the choice recorded. Chosen: neither — the hold gets an identity
  of its own, and a turn releases it only if it still holds that one. See
  [plan.md](./plan.md) § "Release the hold by its identity, not the turn's".
- 2026-09-14 — How far to carry requirement 4: `services/session-report.ts` and
  `merge-watch.ts` share the blind spot. Chosen: all three callers report it;
  only the consult delivery, whose decision is a return value, carries it in its
  API.
