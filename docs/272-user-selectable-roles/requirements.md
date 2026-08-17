---
issue: planning#423
title: User-selectable roles — requirements
description: Let the user start their own session on a configured agent role, not only sub-agents and child sessions.
---

# 272 — User-selectable roles: requirements

**These are the things this feature changes. Everything ShipIt already does is a requirement
too, and is not restated here** — existing behaviour must keep working at least as well as it
does today.

Agent roles exist (docs/264). A role is a complete unit: a harness, a service, a billing mode,
a model, a reasoning level, and optionally a description and standing instructions. Today only
an **agent** can start one, through `shipit agent run --role` and `shipit session create --role`.
A **user** who starts a session themselves cannot. This feature closes that gap.

## Requirements

1. **A user can start their own session on a configured role.** The user selects the role at the
   moment they start the session, before the first message. What they select is one of the roles
   they configured in Settings (docs/264 req 5); this feature adds no second place to define one.

2. **Selecting a role sets what the session runs on.** The session starts on the role's harness,
   service, billing mode, model and reasoning level, and its standing instructions apply to the
   work in that session. This is the reason to select a role instead of setting the individual
   controls: the standing instructions are the part the user cannot express today.

3. **A role is a starting point, not a binding.** Once the session has started it is an ordinary
   session. The user changes the model, the harness or the reasoning level with the controls they
   already use, and the session follows them. ShipIt does not put the role's values back, and does
   not warn the user that they have moved away from the role.

4. **A role is selected when a session starts, and not after.** There is no action that applies a
   role to a session already in progress. Standing instructions describe what a session is for,
   and a session that is already under way is already for something.

5. **Selecting a role does not add a control to the composer.** The composer already carries the
   permission mode, the harness, the model and the reasoning level, and below 700px it collapses
   them into one menu (docs/260). Role selection lives inside what is already there. This is a
   constraint on the design, not a preference: docs/261 records the decision that the composer row
   does not grow.

6. **ShipIt records which role a session was started on.** The user can tell later what a session
   was started as, and so can the agent. Because a role is a starting point (req 3), this is a
   record of how the session began and not a statement about what it is running on now.

7. **Starting a session on a role is optional.** A user who selects nothing gets exactly the
   session they get today, on the harness, model and reasoning level ShipIt already chooses for a
   new session. Roles are an addition to that path, never a step in front of it.

8. **A role the install cannot currently run is not silently repaired.** docs/264 req 7 already
   holds: nothing is ever substituted. A role whose model was retired, or whose service is
   disconnected, does not quietly start on something else. What the user sees in the selection
   surface is an open question below.

## Requirement provenance

Kept separate so that what the user asked for stays visible next to what was proposed to them.

- **From the user's request** — "allow to use roles also in the input for the sessions that the
  user starts themselves": requirements 1 and 2.
- **Proposed in chat and approved by the user on 2026-08-17**: requirements 3, 4, 5 and 6 — the
  role-as-starting-point shape, new sessions only, no new composer control, recorded provenance.
- **Inherited from docs/264 and docs/261, restated here because this feature must not break them**:
  requirements 7 and 8.

## Open questions

- **Does the reserved `reviewer` role appear in the list?** Its params are automatic: it resolves
  to the agent furthest from the one that produced the work (docs/264 req 2). A session the user
  starts themselves has no implementer to be far from, so there is nothing for the rule to measure
  against.

- **What does the user see for a role the install cannot run right now** — one whose model was
  retired, or whose service is disconnected or out of quota (req 8)? ShipIt already models these
  states and shows them in Settings.

- **Which ways of starting a session offer a role?** The composer is one. ShipIt also starts a
  session from quick capture, from a tracked issue, and by forking an existing session.

- **Does the selected role persist to the next new session?** ShipIt remembers the model and the
  harness the user last chose, and seeds the next new session with them.

## Resolved questions

_None yet._
