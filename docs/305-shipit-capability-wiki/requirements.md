---
issue: planning#564
title: ShipIt capability wiki
description: Reference material, shipped into every session, that lets the agent answer "can ShipIt do X?" in the user's own words.
---

# ShipIt capability wiki

The user asks the agent what ShipIt can do — in a session on their own project,
not on the ShipIt repo. Today the agent can answer only what it operates itself
(`/shipit-docs` is a set of operating instructions for the agent's own CLI
surface). Nothing shipped into a session describes ShipIt as a product: what the
user can do, where, and what happens when they do it.

1. A user in any session can ask the agent what ShipIt does in a given
   situation, and the agent answers from material present in that session —
   without guessing, and without sending the user to GitHub or to a doc site.
2. The material covers **every** ShipIt feature, including the many the agent
   never operates: the panels and tabs the user works in, session management,
   the pull-request and review loop, issues, previews, settings, themes, voice,
   mobile, keyboard shortcuts, notifications, and the agent-facing surface that
   already has docs.
3. The material is **data** — markdown files kept up to date in the repository.
   No new UI, no new viewer, no new API.
4. The agent can find the right page from a question phrased in the **user's**
   words ("can I go back to before that change?", "how do I get this on my
   phone?"), not in ShipIt's internal vocabulary ("rewind", "Tailscale").
   Discovery must not depend on guessing a filename.
5. Where a feature's current state can be **queried live** (settings values,
   running services, configured roles), the material names the query rather
   than restating a value that will drift.
6. Coverage includes the self-hosting surface — installing ShipIt, updating it,
   the access options, sizing the machine — not only what happens inside a
   running ShipIt.
7. **Every page is written so that the work lands on an agent, not on the
   user.** Where ShipIt gives an agent a way to do the thing, the page tells the
   agent to do it and never hands the user a command to type. Where the step is
   genuinely the user's — a click only they can make, a credential only they
   hold — the page says so and says exactly where.
8. Requirement 7 holds outside a session too. The agent that installs ShipIt
   runs on the user's host, not inside ShipIt, and the material must read
   correctly to it.
9. Each page says what the user does and what ShipIt does in response,
   precisely enough that the agent can guide the user through a surface the
   agent cannot operate itself.
10. Keeping the material current is part of changing a feature, and the rule
    that says so is written where a contributor will hit it.

## Open questions

_(none)_

## Resolved questions

- **2026-09-14 · How wide does coverage go?** Everything, including
  self-hosting → requirement 6. Nik: *"It needs to cover everything, but it
  needs to be structured and presented in a way so all the operations that the
  agent can do for the user would be performed by the agent. So essentially, it
  shouldn't say, oh, for the user, run this command. It should say, okay, tell
  your agent this or that."* That second half is a constraint on every page, not
  a coverage answer, so it became requirements 7 and 8. On the install case
  specifically: *"in the case of installing ShipIt, it would not be running
  inside ShipIt — it would be running on the host. But this is how people work
  now. So it needs to be agent-oriented, but for the user."*
- **2026-09-14 · Does freshness need a mechanical gate?** No — a written rule in
  `CLAUDE.md`, alongside the one that already governs `src/server/shipit-docs`
  (requirement 10). Nik chose the convention over a build check and over a
  scheduled drift audit.
- **2026-09-14 · Who writes the pages?** A thorough first slice first, written
  in this session, so the depth and the voice can be judged against real pages
  before the rest is commissioned.
