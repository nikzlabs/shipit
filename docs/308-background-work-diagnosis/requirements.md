---
title: Why background work did not run
description: A failed voice cleanup — or any background-work run — says why, inside ShipIt, after the moment has passed.
---

# Why background work did not run

Voice cleanup falls back to the raw transcript with one fixed sentence —
"Cleanup unavailable — inserted raw transcript" — that names no cause. The user
cannot tell a missing credential from an exhausted balance from a ShipIt defect,
and the only place the cause exists today is `console.warn` in the orchestrator's
own stdout.

1. When voice cleanup inserts the raw transcript, the user can find out **why**.
   The answer separates at least these cases, in plain language: nothing on this
   install is set up to run the work; the provider refused the call (a rejected
   key, an expired sign-in, an exhausted balance or quota); the run was too slow
   and hit ShipIt's deadline; the run answered but ShipIt rejected the answer;
   ShipIt itself failed.

2. Where the provider gave its own reason for refusing, **that reason is what the
   user sees**. "I ran out of money" and "this is a bug in ShipIt" must be
   distinguishable without guessing.

3. The answer is reachable **inside ShipIt** — not from container logs, a shell,
   or a provider's dashboard.

4. The reason **outlives the moment**. A user who sees the fallback, keeps
   dictating, and asks about it later can still find out what happened to that
   run.

5. The same applies to background work of every kind — session naming, pull-request
   descriptions, transcript cleanup — not to voice cleanup alone.

## Open questions

- **Scope of the first cut.** Req 5 came from "maybe including all types of
  background work". Does the first change cover every background-work purpose, or
  voice cleanup alone with the rest following?
- **Where the answer lives.** A specific transient warning on the mic button and a
  specific status line in Voice settings answers reqs 1–3 but not req 4. A list of
  recent background-work runs (outcome, model, reason) under Settings → Background
  work answers req 4 as well. Which is wanted, and is the transient warning still
  wanted if the list exists?
- **How long the record is kept**, and whether it survives an orchestrator restart.
- **How much provider text to show.** The provider's own message (for example
  `insufficient_quota: You exceeded your current quota`) is the thing that answers
  req 2, but it is raw vendor prose. Show it verbatim, or map it to ShipIt's own
  wording?

## Resolved questions

_None yet._
