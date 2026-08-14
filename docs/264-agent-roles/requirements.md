---
issue: planning#363
title: Agent roles — requirements
description: User-defined agent roles — a harness, a model, a reasoning level and an optional prompt — invoked by name.
---

# 264 — Agent roles: requirements

**These are the things this feature changes. Everything ShipIt already does is a requirement
too, and is not restated here** — existing behaviour must keep working at least as well as it
does today.

A user preconfigures **agent roles**: named units of agent work, each naming the harness that
runs it, the model it runs (a service, a billing mode and a model id), the reasoning level, and
optionally a standing prompt describing the job. An agent starts a role **by name**, and supplies
nothing else.

## Requirements

1. **A user can create any number of agent roles**, and each role is a **complete** unit — the
   harness, the service, the billing mode, the model and the reasoning level. Nothing about a
   role is left for the agent to decide when it starts one, and nothing is left for ShipIt to
   derive while it runs.

2. **The reviewer is a role.** Asking for a review and asking for any other role are the same
   action: name the role. A role may be a reviewer, or any other job.

3. **A role is started by name, and the agent works out which role the user means.** "Review the
   PR" reaches the reviewer role without the user naming it; "review with `deep-dive`" names a
   role explicitly, and that name is used as given rather than re-interpreted. Both are the same
   action: **the agent supplies a role, never a param.** Mapping an intent onto a role is the
   agent's judgement; what that role runs on is the user's (req 1).

4. **Starting a role costs a name and nothing else.** A role is invoked in one word, or in no
   word at all when the intent alone resolves it (req 3). The user never restates the model, the
   level or the harness at the moment of use — that is what they configured the role for.

5. **Roles are created and edited in ShipIt's settings UI.** The UI is where a role comes from:
   it is the surface that can show the user which services, models, harnesses and reasoning
   levels their install actually offers, which is what choosing a role's params requires.

6. **A role names its harness, and the harness is required.** A role carries
   `(harness, service, billing mode, model, level)`. It is not derived, not optional and not
   re-decided per run: a role is a *job definition*, and which agent performs the job is part of
   the job — Claude Code driving a model and Codex driving the same model are different agents,
   with different scaffolding, tools and agentic loops.

   A role whose harness cannot run its model is **refused when it is saved**, not silently
   repaired.

7. **A role names exactly what it runs.** Its params are pinned: a role never resolves its own
   model, and never runs on anything other than what it names.

8. **A role may carry an optional standing prompt — its job description — which composes with
   the task it is given when it is started.** The prompt is user data stored with the role, and
   the run's prompt is one channel: the role's standing half first, then the task half. A role
   without a prompt is a complete role; the prompt extends, it does not gate.

9. **A role is a unit; it is not overridden when it is started.** Naming a role together with a
   model or a reasoning level is refused. A variation the user wants is a different role.

10. **A role can be used for either way of starting an agent: a one-shot run, or a child
    session.** These are the two shapes a sub-agent takes — a consult that returns its output to
    the caller, and a session with its own branch and pull request — and a role names what runs,
    which is the same question in both. A child session started with a role runs that role
    completely, rather than inheriting its parent's harness and model.

11. **The agent can see which roles exist.** It can read this install's roles — their names and
    what each is for — so that it can map an intent onto one (req 3), tell the user what is
    available when they ask, and name the alternatives when a role does not resolve (req 12).
    An agent that has to guess a role name is the same failure as an agent that has to guess a
    model: a confident wrong answer whose origin the user cannot see.

    This is scoped to **roles**. Nothing here requires exposing the service and model catalogue
    to the agent; that belongs to the UI (req 5).

12. **An unknown role name is refused, and the refusal names the roles that do exist.** The name
    is resolved server-side, and the user is told what they can say next rather than what they
    did wrong.

13. **What a role's run did is reported and attributed** — the service, the model, the harness
    and the level it actually ran on, with its usage and cost attributed to the service and
    billing mode that served it. This restates an obligation ShipIt already has, because this
    feature must not lose it.

14. **ShipIt does not document a path to the agent that the agent cannot use.** A way of starting
    an agent that requires naming parameters the agent has no way to enumerate is not described
    in the instructions ShipIt injects. The path may remain implemented for callers that have
    those values; it is simply not advertised to a caller that cannot.

## Scope

A role covers **what an agent runs on** and, optionally, **what job it is for**. It does not
cover when a role is used, which is the agent's judgement (req 3), or what any given run is
asked to do, which arrives with the run.

Roles are configured in ShipIt and apply to every session and repository, in the way ShipIt's
other agent settings already do.

## Open questions

1. **Should the reviewer keep behaving differently from every other role?** The human: *"I'm not
   sure if we need to keep the special casing of the reviewer role. What do you think?"*

   The reviewer is currently the one role whose params are **not** pinned: ShipIt derives them,
   ranking two configured candidates by distance from whichever model is implementing, so a
   review is never performed by the thing that produced the work and an install that has
   configured nothing still reviews. Every other role is a fixed tuple (reqs 1, 6, 7).

   **The special case is not arbitrary, and that is the honest difficulty:** "use whoever is
   furthest from the model that wrote this" is a **rule evaluated per run**, and a role is a
   **fixed tuple**. A static role cannot express it, because the answer depends on what is
   implementing at the moment of the call. Dropping the special case therefore does not simplify
   the concept — it deletes a behaviour, and specifically these three:

   - reviewing never falls to the model that wrote the work;
   - reviewing works on an install where nobody has configured anything;
   - the reviewer improves by itself when a service is added.

   **Recommended: keep the behaviour, and stop calling it a special case.** Rather than "roles,
   plus a different thing called the reviewer", state it as: **a role's params are pinned, and
   ShipIt ships one role whose params are automatic.** That is one concept with one exception the
   user can see and reason about, rather than two kinds of object — and it leaves room for
   "automatic" to become a choice on any role later, if it is ever wanted, without re-cutting
   anything.

   **What the alternative costs, stated plainly so the choice is real.** Making the reviewer an
   ordinary pinned role means ShipIt seeds one at first run and it is thereafter a fixed tuple
   like any other. The concept gets genuinely simpler — one kind of role, no exception — and the
   three behaviours above are lost: a role pinned to the model that happens to be implementing
   will review its own work, a fresh install has no reviewer until someone makes one, and a
   seeded role stops following the install. That is a coherent product, and it is a different one.

## Resolved questions

- 2026-08-14 — **Is the harness part of a role?** **Chosen: yes, and required.** Offered as an
  optional constraint; the human: *"let's require it."* Req 6. Two consequences worth recording:
  a named harness is frozen, so a role whose harness is uninstalled reports that it cannot run
  rather than quietly running on another one; and a role's reasoning level is validated against
  the one harness it names, so a level can never be carried onto a harness that does not declare
  it.

- 2026-08-14 — **Does a role work for child sessions as well as one-shot runs?** **Chosen: yes.**
  The human: *"I think there should be two ways to run a sub-agent. One is as a review and another
  as a child session. So maybe in the child session API, the agent should be able to specify the
  role."* Req 10. Checked rather than assumed: `shipit session create` today accepts `--agent`
  and `--model` and no reasoning flag at all, so a child session can currently be given two of
  the three parameters that decide what it runs on. A role supplies all of them at once, which is
  what makes it worth naming there.

- 2026-08-14 — **Is the one-off, unsaved combination a requirement?** **Chosen: no — removed.**
  The human: *"remove this requirement."* Asking for a model and a level for a single run is not
  something this feature has to provide.

- 2026-08-14 — **Does ShipIt offer to save a combination that recurs?** **Chosen: no — not in
  v1.** The human: *"remove, not in v1."* Roles are created deliberately, in the UI (req 5).

- 2026-08-14 — **What happens to the fully-explicit run that names every parameter?** **Chosen:
  leave it implemented, remove it from the injected documentation.** The human's words exactly.
  Req 14 states the general rule it is an instance of. Verified before recording: that path
  requires the harness, service, billing mode, model and reasoning level together and refuses an
  incomplete call, while the session shim offers no way to list services, models, billing modes
  or levels — so an agent can satisfy it only by guessing. A caller that already holds all five,
  such as a repository that hard-codes them, keeps working.

- 2026-08-14 — **Who picks the role — the user's exact word, or the agent's reading of the
  intent?** **Chosen: the agent works out which role is meant.** The human: *"The agent should be
  able to figure out the correct role. E.g. 'review the PR' -> role == reviewer."* Req 3. The
  agent still supplies no param: it may choose a role, and may never choose a model or a level,
  which are values it has no way to enumerate. Req 11 exists because an agent can only map an
  intent onto roles it can see.

- 2026-08-14 — **Is role creation chat-native?** **Chosen: no — roles are created in the UI.**
  The human: *"In v1 roles are fully created in the UI."* Req 5. Choosing a role's params means
  choosing among the services, models, harnesses and levels *this install* offers, and the UI is
  the only surface that can show that set.

- 2026-08-14 — **Must a role's params be pinned, or may ShipIt resolve them?** **Chosen:
  pinned.** Req 7. Whether the reviewer is an exception is open question 1.

- 2026-08-14 — **May a role be overridden when it is started?** **Chosen: no — a role is a
  unit.** Req 9.

- 2026-08-14 — **Does a role carry a standing prompt?** **Chosen: yes, optional.** Req 8.

- 2026-08-14 — **Are roles the unit, rather than named reviewers?** **Chosen: roles.** The human:
  *"How about we generalize reviewers to any agent roles? So essentially the user would be able to
  preconfigure various agent roles, where it would be the params we have now and maybe also some
  prompt."* Reqs 1, 2 and 3. A reviewer is one role, invoked the same way as any other.

## Requirement provenance

The feature exists because of a direction the product owner described, and most of its shape is
his. What he actually said:

- "generalize reviewers to any agent roles … the user would be able to preconfigure various agent
  roles, where it would be the params we have now and maybe also some prompt" → reqs 1, 2, 3
  and 8.
- "add as many … as they want and invoke one by name ('review with `deep-dive`')" → reqs 1 and 3.
- "invocation by name is at least as short as the ad-hoc spelling" → req 4.
- "The agent should be able to figure out the correct role. E.g. 'review the PR' -> role ==
  reviewer." → req 3.
- "In v1 roles are fully created in the UI." → req 5.
- "So help me understand why the user shouldn't be able to select the harness," and then "let's
  require it." → req 6. Both moves are his: the challenge, and the decision to go from an optional
  constraint to a required one.
- "today doesn't work at all because the agent has to specify all the params, and it does not have
  access to the inventory" → reqs 11 and 14.
- "Leave it implemented, but remove from the injected documentation." → req 14.
- "I think there should be two ways to run a sub-agent. One is as a review and another as a child
  session. So maybe in the child session API, the agent should be able to specify the role." →
  req 10.

Reqs 7 and 9 are his answers to questions put to him, recorded above. Reqs 12 and 13 are the
agent's: req 12 because a name-space open to user-defined names must fail legibly, and req 13
because attribution is an obligation ShipIt already has and this feature must not lose it.
