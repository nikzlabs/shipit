# 131 — Dogfood seed sessions: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

This feature is about the ShipIt-in-ShipIt dogfood loop (feature 118): the inner
ShipIt that runs as the `dev` Compose service and renders in the outer preview
pane. Requirements 1–8 are the original goal — the inner ShipIt should come up
with repos already there. Requirements 9–10 are what the outer agent must be
able to do with it.

## Requirements

1. When the dogfood inner ShipIt comes up, a defined set of repo-backed inner
   sessions is already there — nobody has to click through "open repo → create
   session" before there is something to test against.

2. The set of repos is defined by a file in the repository, so it is the same
   set every time and for everyone, and reading the file tells you what the
   inner ShipIt will contain.

3. A developer can point the dogfood loop at their own repos instead, without
   committing that choice.

4. Seeding can be turned off entirely.

5. Restarting the dogfood service does not create duplicates and does not redo
   work for sessions that are already there.

6. A repo that fails to seed — a bad entry, a repo that can't be cloned — does
   not stop the inner ShipIt from coming up, and does not stop the other repos
   from being seeded.

7. Seeding does not hold up the inner UI. The inner ShipIt is usable while the
   repos are still arriving.

8. When seeding cannot work because the inner ShipIt has no GitHub access, the
   reason for that is visible, rather than repos silently not appearing.

9. The outer agent can make an inner agent start working on a task in the inner
   ShipIt, without a human driving the inner UI.

10. The outer agent can read back an inner session's conversation — what the
    inner agent said and what it did — to see what happened.

## Open questions

- **What does "start an inner agent" apply to?** Requirement 9 could mean
  (a) sending a task to one of the seeded sessions, (b) creating a fresh inner
  session with an opening prompt, or (c) both. These are not the same amount of
  work: (b) is already reachable over the inner ShipIt's HTTP API, while (a) is
  currently WebSocket-only (noted as a gap in `docs/160-external-control-api`).
  *Recommendation: (c) both, because the seeded repos from requirements 1–8 are
  the point — being able to start work only in throwaway new sessions would
  leave the seeded ones untestable.*

- **Start-and-watch, or a full conversation?** Does the outer agent need to
  reply to the inner agent — follow-ups, answering a question it asks,
  interrupting it — or is starting it once and reading the result enough?
  *Recommendation: start-and-watch for this version. Replying is the same
  primitive as (a) above, so it comes along if (a) is in scope, but nothing
  should be designed around a back-and-forth until we want one.*

- **Does the outer agent need to know when the inner agent has finished?**
  Requirement 10 says the outer agent can read the conversation; it does not say
  it can tell "still working" from "done". Without that, the outer agent has to
  guess when to look, which matters if this is meant to be used unattended.
  *Recommendation: yes, include it — the inner ShipIt already reports whether a
  session is running, so this is reading something that exists, not building
  something new.*

## Resolved questions

_(none yet)_
