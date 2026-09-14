---
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
6. Each page says what the *user* does and what ShipIt does in response,
   precisely enough that the agent can guide the user through a surface the
   agent cannot operate itself.
7. Keeping the material current is part of changing a feature, and the rule
   that says so is written where a contributor will hit it.

## Open questions

- Does coverage stop at what a user does inside a running ShipIt, or does it
  also include the self-hosting surface — installing, updating, the VPS and
  tunnel options, resource sizing, backups?
- Is requirement 7 satisfied by a written convention, or does it need a
  mechanical check that fails a build when a feature ships without its wiki
  page?
- Should the pages be written in one pass in this session, or fanned out across
  child sessions with one PR per feature area?

## Resolved questions

