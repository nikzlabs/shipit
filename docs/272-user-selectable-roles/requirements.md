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

1. **A user can start their own session on a configured role.** The user selects the role before
   the session does any work. What they select is one of the roles they configured in Settings
   (docs/264 req 5); this feature adds no second place to define one.

2. **Selecting a role sets what the session runs on.** The session starts on the role's harness,
   service, billing mode, model and reasoning level, and its standing instructions apply to the
   work in that session. This is the reason to select a role instead of setting the individual
   controls: the standing instructions are the part the user cannot express today.

3. **A role is a starting point, not a binding.** Once the session has started it is an ordinary
   session. The user changes the model, the harness or the reasoning level with the controls they
   already use, and the session follows them. ShipIt does not put the role's values back, and does
   not warn the user that they have moved away from the role. It does show them where they now
   stand (req 13).

4. **A role can be selected until the session's first turn starts, and not after.** A session that
   exists but has done no work is still a session the user can configure — starting one from a
   tracked issue or by forking another does not begin a turn, so the user chooses there in the
   same place they choose the model. Once a turn has run there is no action that applies a role.
   Standing instructions describe what a session is for, and a session that is already under way
   is already for something.

5. **A selected role replaces the controls it set. The composer shows the role name, and nothing
   else about what the session runs on.** The harness, the model and the reasoning level are what
   the role is *made of*; once the user has chosen the role, restating its three parts tells them
   nothing they did not just decide. The permission mode is not a role parameter and is unaffected.

   The composer therefore carries **one** role affordance: the role's name when a role is selected,
   and a way to select one when none is. This sets aside docs/261's decision that the composer row
   does not grow — deliberately, on the user's instruction, and recorded here rather than left to
   be discovered as a contradiction. The row still does not grow *while a role is selected*: it
   shows fewer labels than it does today, not more.

6. **ShipIt records which role a session was started on.** The user can tell later what a session
   was started as, and so can the agent. Because a role is a starting point (req 3), this is a
   record of how the session began and not a statement about what it is running on now.

7. **Starting a session on a role is optional.** A user who selects nothing gets exactly the
   session they get today, on the harness, model and reasoning level ShipIt already chooses for a
   new session. Roles are an addition to that path, never a step in front of it.

8. **A role the install cannot currently run is not silently repaired.** docs/264 req 7 already
   holds: nothing is ever substituted. A role whose model was retired, or whose service is
   disconnected, does not quietly start on something else.

9. **A role the install cannot run stays visible, and says why.** It appears in the selection
   surface, cannot be selected, and shows its reason — stranded, disconnected, or out of quota —
   as Settings shows it today. A role the user configured does not disappear without an
   explanation, because a role that vanishes reads as a fault in ShipIt.

10. **The reviewer role is not offered to the user.** The reviewer resolves its own params: it
    picks the agent furthest from the one that produced the work (docs/264 req 2). A session the
    user starts themselves has no such agent, so the rule has nothing to measure and would resolve
    to an arbitrary agent while looking deliberate. The reviewer stays a role an agent starts.

11. **Every surface that starts a session offers the role.** The user selects a role in the
    composer and in the quick-capture overlay, which are the two surfaces that start a session and
    its first turn together. Starting from a tracked issue and forking a session need nothing
    added: neither begins a turn, so the user selects the role in the composer of the session they
    have just landed in (req 4).

12. **ShipIt remembers the role the user last selected, and starts the next new session on it.**
    This is how ShipIt already treats the model and the harness the user chose. The role is still a
    starting point (req 3) and still optional (req 7): the user changes it, or clears it, in the
    same place they selected it.

13. **ShipIt shows when the current combination is one of the user's roles.** Whenever the
    harness, service, billing mode, model and reasoning level a session is set to are the same as
    a role's, ShipIt names that role. This holds however the combination was reached: by selecting
    the role, by setting the controls one at a time, or by moving away from a role and back again.
    ShipIt indicates the match; it never re-applies the role.

    Three things this states, because each is a case the user meets:

    - **A match is on the parameters only.** A role's standing instructions are not part of what a
      session is set to, so a session that matches a role's parameters is not running its
      instructions. The indication says the settings are the role's, and never implies more.
    - **The reviewer is never indicated**, for the same reason it is never offered (req 10).
    - **When the combination is nobody's role, ShipIt says nothing about roles.** The plain
      combination is the ordinary case, not a deviation, and must not be shown as one.

14. **The role name opens the list of roles, like every other control in the row opens its own
    list.** Clicking a control in the composer opens what that control chooses between; the role is
    not the one exception. So the role name opens the roles, and switching role is the ordinary,
    one-click act.

15. **The parameters a role set stay reachable, and changing one is what leaves the role.** The
    controls the role replaced are brought back from inside the roles list, which is where the user
    already is when they are thinking about what the role runs on. Once back, they are the ordinary
    controls, in their ordinary place.

    The moment the combination is no longer the role's, the composer returns to its ordinary form —
    the three controls, shown as they are today (req 13) — and offers to select a role again.
    Nothing is confirmed, warned about or put back: changing a control is the whole of leaving a
    role, and selecting one again is the whole of returning.

    Below 700px this is the same fact in the shape docs/260 already uses: the role folds into the
    one composer settings menu, alongside the controls it sets.

16. **Roles are not listed among the models.** A role is not a model — it carries a harness, a
    reasoning level and standing instructions that no model row can express — and the model list is
    long already. Putting roles inside it would crowd the one list users open most, and would teach
    that a role is a kind of model.

## Requirement provenance

Kept separate so that what the user asked for stays visible next to what was proposed to them.

- **From the user's request** — "allow to use roles also in the input for the sessions that the
  user starts themselves": requirements 1 and 2.
- **Proposed in chat and approved by the user on 2026-08-17**: requirements 3, 4 and 6 — the
  role-as-starting-point shape, new sessions only, recorded provenance.
- **Directed by the user on 2026-08-17, replacing what was proposed**: requirements 5, 14, 15 and
  16. The agent had proposed that role selection live inside the model menu and add no control. The
  user replaced this: a selected role shows its **name alone**, its parameters stay reachable, and
  roles do not belong in the model list. The user then caught the agent giving the role name a
  click that no other control has (req 14). See the receipts below.
- **Inherited from docs/264 and docs/261, restated here because this feature must not break them**:
  requirements 7 and 8.
- **Answered by the user on 2026-08-17**: requirements 9, 10, 11 and 12, and the wording of
  requirement 4. See the receipts below.
- **Asked for by the user on 2026-08-17, reviewing this document**: requirement 13, and the last
  sentence of requirement 3 — "it should indicate if the current combination matches some role
  (excluding reviewer roles)".

## Open questions

- **When two roles carry the same five parameters, which one does ShipIt name (req 13)?** Roles
  are unique by name, not by parameters, so nothing stops a user from configuring two that are
  identical to run on. Assumed for the prototype: ShipIt names the first by name and does not
  hint that others match. This is low stakes and does not block design; correct it if you disagree.

## Resolved questions

- **2026-08-17 — Does the reserved `reviewer` role appear in the list?** No: hide it. The user
  chose this over showing it resolved normally, and over showing it only once edited. → req 10.

- **2026-08-17 — What does the user see for a role the install cannot run right now?** It is shown,
  disabled, with its reason, as Settings shows it. The user chose this over hiding it, and over
  letting the user select it and failing at start. → req 9.

- **2026-08-17 — Which ways of starting a session offer a role?** The composer and the quick-capture
  overlay. The user noted that starting from a tracked issue **does not start a turn**, so the user
  can choose the configuration after clicking, and said the same holds for a fork. Those two paths
  therefore need nothing of their own. → req 11, and the rewording of req 4 from "when a session
  starts" to "until the session's first turn starts".

- **2026-08-17 — Does the selected role persist to the next new session?** Yes, remember it, as
  ShipIt already remembers the model and the harness. → req 12.

- **2026-08-17 — What does the composer show while a role is selected?** The role name, and nothing
  else about what the session runs on: "I don't really need all the parameters… it needs to be only
  the role name, and that's it." The parameters open from the name — "maybe I click on the role and
  the controls appear" — and below 700px the role folds into the composer settings menu. Changing a
  parameter so it no longer matches returns the row to today's form, with a way to select a role
  still present. → req 5, req 14. This replaced the agent's proposal of a role *label* beside the
  three controls, and with it the whole clip-group argument that had chosen between two ways of
  writing that label.

- **2026-08-17 — What does clicking the role name do?** It opens the list of roles. The user
  challenged the agent's "clicking the role name reveals what it set" — "wouldn't clicking open the
  role menu?" — and it would: every other control in the composer opens what it chooses between, so
  a role name that instead expanded a panel would be the single exception a user has to learn.
  Switching role is the common act and gets the plain click; the parameters are reached from inside
  that same list. → req 14, req 15.

- **2026-08-17 — Do roles appear in the model menu?** No. "I would not put it in the models because
  it's not actually a model, and the model list can be already crowded." → req 15. This replaced
  the agent's proposal of a Roles group at the top of the model menu, which was the shape the whole
  first prototype was built around.
