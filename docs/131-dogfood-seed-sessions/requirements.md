# 131 — Dogfood seed sessions: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

This feature is about the ShipIt-in-ShipIt dogfood loop (feature 118): the inner
ShipIt that runs as the `dev` Compose service and renders in the outer preview
pane. Requirements 1–7 are the original goal — the inner ShipIt should come up
with a repo already there. Requirements 8–10 are what the outer agent must be
able to do with it.

## Requirements

1. When the dogfood inner ShipIt comes up, at least one repo-backed inner
   session is already there — nobody has to click through "open repo → create
   session" before there is something to test against.

2. What gets seeded is defined by a file in the repository, so it is the same
   every time and for everyone, and reading that file tells you what the inner
   ShipIt will contain.

3. Seeding can be turned off entirely.

4. Restarting the dogfood service does not create duplicates and does not redo
   work for sessions that are already there.

5. A repo that fails to seed — a bad entry, a repo that can't be cloned — does
   not stop the inner ShipIt from coming up, and does not stop the other repos
   from being seeded.

6. Seeding does not hold up the inner UI. The inner ShipIt is usable while the
   repos are still arriving.

7. When seeding cannot work because the inner ShipIt has no GitHub access, the
   reason for that is visible, rather than repos silently not appearing.

8. The outer agent can make an inner agent start working on a task in the inner
   ShipIt, without a human driving the inner UI. This applies both to the
   sessions that were seeded (requirement 1) and to a fresh session the outer
   agent creates with an opening task.

9. The outer agent can read back an inner session's conversation — what the
   inner agent said and what it did — to see what happened.

10. The outer agent can tell whether an inner session is still working or has
    finished, so it knows when there is something to read.

Not required in this version: the outer agent replying to an inner agent
mid-task — follow-up messages, answering a question the inner agent asks,
interrupting it. Starting it and reading the result is enough (see the resolved
question below).

## Open questions

_(none — implementation is unblocked.)_

## Resolved questions

- 2026-08-04 — Should a developer be able to seed their own repos without
  committing that choice, via a gitignored override of the file in requirement 2?
  Chosen: **no, not now** — there is one developer, so a personal set and the
  committed set are the same thing. The committed fixture is the only input.
  Requirement 2 is unchanged and stands on its own; nothing needs to be built to
  close this. If a second developer arrives, or if repos worth dogfooding against
  turn out not to belong in the committed fixture, revisit — the seed script
  reads a file either way, so it stays a small change.

- 2026-08-04 — Does requirement 1 need a *defined set* of sessions to be present,
  as originally written? Chosen: **no** — at least one repo-backed session is
  enough. Requirement 1 was weakened accordingly, and requirement 2 reworded to
  match ("what gets seeded" rather than "the set of repos").

- 2026-08-04 — Where does "seeding can be turned off entirely" come from?
  Answer: from the existing `plan.md`, which specified a `DOGFOOD_SEED=0` switch.
  Kept as requirement 3, approved on review.

- 2026-08-04 — Does "start an inner agent" (req 8) mean sending a task to one of
  the seeded sessions, creating a fresh session with an opening prompt, or both?
  Chosen: **both**. The seeded repos are the point of requirements 1–7, so
  starting work only in fresh throwaway sessions would leave them untestable.
  Requirement 8 was extended to say so. Cost: creating-with-a-prompt is already
  an HTTP route on the inner ShipIt, but sending a message to an *existing*
  session is WebSocket-only today — the gap `docs/160-external-control-api`
  identifies — so this half needs building.

- 2026-08-04 — Does the outer agent need to talk back to the inner agent
  (follow-ups, answers, interrupts), or only start it and read the result?
  Chosen: **start and watch only**. Recorded above as an explicit
  non-requirement so the design isn't built around a conversation loop. The
  underlying primitive is the same one requirement 8 needs, so a later version
  can add it without rework.

- 2026-08-04 — Should the outer agent be able to tell "still working" from
  "done", which requirement 9 alone doesn't give it? Chosen: **yes**. Added as
  requirement 10. The inner ShipIt already reports whether a session is running,
  so this reads something that exists rather than building something new.
