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
runs it, the model it runs (a service, a billing mode and a model id), the reasoning level, what
the role is for, and optionally standing instructions describing the job. An agent starts a role
**by name**, and supplies nothing else.

There is one kind of role. What a role's params may be is where the only variation lives: the
user pins them (req 7), and ShipIt ships one role — the reviewer — whose params it resolves
instead (req 2).

## Requirements

1. **A user can create any number of agent roles**, and each role is a **complete** unit — the
   harness, the service, the billing mode, the model and the reasoning level. Nothing about a
   role is left for the agent to decide when it starts one.

2. **The reviewer is a role, and it is the one role whose params ShipIt resolves.** Asking for a
   review and asking for any other role are the same action: name the role. What sets the
   reviewer apart is not its kind but its params — they are **automatic** rather than pinned, so
   that:

   - a review is never performed by the model that produced the work, whenever any alternative
     is available;
   - reviewing works on an install where nobody has configured anything;
   - the reviewer improves by itself as the install changes — adding a service can make it a
     better reviewer with no one editing it.

   These are things a fixed set of params cannot express, because the answer depends on what is
   doing the work at the moment the review is asked for. That is why this one role resolves
   rather than being pinned, and it is the only reason.

   **The reviewer is always present**: its name is reserved, and it cannot be renamed or deleted.
   Its params and its prompt are editable like any other role's. A reviewer that could be renamed
   away would leave "review this" with nothing to resolve to, and would break the promise that
   reviewing works on an install where nobody has configured anything.

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

6. **A role with pinned params names its harness, and the harness is required.** Such a role
   carries `(harness, service, billing mode, model, level)`. The harness is not optional and not
   re-decided per run: a role is a *job definition*, and which agent performs the job is part of
   the job — Claude Code driving a model and Codex driving the same model are different agents,
   with different scaffolding, tools and agentic loops.

   A role whose harness cannot run its model is **refused when it is saved**, not silently
   repaired.

   This governs pinned params, which is every role but one. The reviewer's params are automatic
   (req 2), and its harness is part of what ShipIt resolves — that is the exception req 2 already
   names, not a second rule.

7. **A role's params are pinned, and a role runs on what it names and nothing else.** The single
   exception is the reviewer ShipIt ships (req 2). A user's role never resolves its own model and
   is never re-pointed at another one.

8. **A role may carry standing instructions — what the job is — which apply whenever the role is
   started, in addition to the task it is given.** A role without them is a complete role.

9. **Every role says what it is for**, in a short description the agent and the user can both
   read, whether or not it carries standing instructions.

10. **A role is a unit; it is not overridden when it is started.** Naming a role together with
    any parameter that would say what to run on — a harness, a service, a billing mode, a model
    or a reasoning level — is refused. A variation the user wants is a different role.

11. **A role can be used for either way of starting an agent: a one-shot run, or a child
    session.** These are the two shapes a sub-agent takes — a consult that returns its output to
    the caller, and a session with its own branch and pull request — and a role names what runs,
    which is the same question in both. A child session started with a role runs that role
    completely, rather than inheriting its parent's harness and model.

    A child session so started behaves in every other way like a child session started any other
    way: it keeps its own routing, failover and model-retirement behaviour across its whole life,
    rather than being frozen to the moment it was created.

12. **The agent can see which roles exist.** It can read this install's roles — their names and
    what each is for (req 9) — so that it can map an intent onto one (req 3), tell the user what
    is available when they ask, and name the alternatives when a role does not resolve (req 13).
    An agent that has to guess a role name is the same failure as an agent that has to guess a
    model: a confident wrong answer whose origin the user cannot see.

    This is scoped to **roles**: it is the smallest surface that answers req 3, and it keeps the
    agent choosing roles rather than assembling params.

13. **An unknown role name is refused, and the refusal names the roles that do exist.** The name
    is resolved server-side, and the user is told what they can say next rather than what they
    did wrong.

14. **What a role's run did is reported and attributed** — the service, the model, the harness
    and the level it actually ran on, with its usage and cost attributed to the service and
    billing mode that served it. This holds for both ways of starting a role (req 11).

15. **ShipIt does not tell an agent to assemble a run out of parameters it cannot enumerate.**
    The instructions ShipIt injects into a session do not describe a way of starting an agent
    that requires naming a harness, a service, a billing mode, a model and a level together,
    because nothing in a session lets an agent discover those values. The path remains
    implemented, and remains documented for the humans and repositories that do hold those
    values — it simply stops being offered to the caller that cannot.

## Scope

A role covers **what an agent runs on** and, optionally, **what job it is for**. It does not
cover when a role is used, which is the agent's judgement (req 3), or what any given run is
asked to do, which arrives with the run.

Roles are configured in ShipIt and apply to every session and repository, in the way ShipIt's
other agent settings already do.

## Open questions

1. **What happens to a role whose model is retired?** ShipIt's catalogue can retire a model and
   declare a successor, and sessions and reviewer pins are moved onto it automatically. Req 7
   says a role runs on what it names and is never re-pointed, so the two rules collide the first
   time a role's model is retired.

   **Recommended: the role stops working and says so, and the user re-points it in Settings.**
   That is what req 7 already promises, and it is the behaviour the required harness was chosen
   for — being told a job cannot run beats being quietly handed a different one. The cost is that
   a retirement can leave a role broken until someone edits it, where a reviewer pin would have
   carried on. If that cost is not wanted, the alternative is to amend req 7 to allow retirement
   successors specifically, which is a change to what "pinned" means and so is yours to make.

2. **What may a role be named?** The design assumes a short token — lowercase letters, digits and
   dashes — so `--role NAME` is one word. That is a user-visible restriction nobody asked for.
   **Recommended: allow any name the user types, with only uniqueness enforced**, and quote it
   where a command needs to. The stricter rule is worth taking only if role names should be
   guaranteed typeable without quoting.

3. **Do reqs 13 and 14 stand?** Both are the agent's, not yours: req 13 because a name-space open
   to user-defined names has to fail legibly, and req 14 because attribution is an obligation
   ShipIt already has and this feature must not lose it. Neither came from anything you said.
   **Recommended: keep both** — but they are listed here rather than buried, because a
   requirement nobody asked for should be struck rather than inherited by default.

## Resolved questions

- 2026-08-14 — **Should the reviewer keep behaving differently from every other role?** **Chosen:
  keep the behaviour, drop the framing.** Put to the human as a real choice, with the cost of the
  alternative stated; he took the recommendation — *"ok good."*

  So there is **one kind of role**, and the variation lives in a role's params: a user pins them
  (req 7), and ShipIt ships one role whose params it resolves (req 2). The reviewer is not a
  different sort of object, and it is not exempt from anything else a role is — it is named the
  same way, started the same way, refused the same way and reported the same way.

  Why the behaviour could not simply be dropped: *"use whoever is furthest from the model that
  wrote this"* is a **rule evaluated per run**, while a role is a **fixed set of params**. The
  answer depends on what is doing the work at the moment the review is asked for, so no fixed set
  can encode it. Removing the reviewer's automatic params would therefore have deleted the three
  behaviours req 2 now lists rather than simplifying the concept. The alternative — seeding an
  ordinary pinned reviewer at first run — was a coherent and genuinely smaller product, and is
  the one not taken.

- 2026-08-14 — **Is the harness part of a role?** **Chosen: yes, and required.** Offered as an
  optional constraint; the human: *"let's require it."* Req 6. Two consequences worth recording:
  a named harness is frozen, so a role whose harness is uninstalled reports that it cannot run
  rather than quietly running on another one; and a role's reasoning level is validated against
  the one harness it names, so a level can never be carried onto a harness that does not declare
  it.

- 2026-08-14 — **Does a role work for child sessions as well as one-shot runs?** **Chosen: yes.**
  The human: *"I think there should be two ways to run a sub-agent. One is as a review and another
  as a child session. So maybe in the child session API, the agent should be able to specify the
  role."* Req 11. Checked rather than assumed: `shipit session create` today accepts `--agent`
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
  Req 15 states the general rule it is an instance of. Verified before recording: that path
  requires the harness, service, billing mode, model and reasoning level together and refuses an
  incomplete call, while the session shim offers no way to list services, models, billing modes
  or levels — so an agent can satisfy it only by guessing. A caller that already holds all five,
  such as a repository that hard-codes them, keeps working.

- 2026-08-14 — **Who picks the role — the user's exact word, or the agent's reading of the
  intent?** **Chosen: the agent works out which role is meant.** The human: *"The agent should be
  able to figure out the correct role. E.g. 'review the PR' -> role == reviewer."* Req 3. The
  agent still supplies no param: it may choose a role, and may never choose a model or a level,
  which are values it has no way to enumerate. Req 12 exists because an agent can only map an
  intent onto roles it can see.

- 2026-08-14 — **Is role creation chat-native?** **Chosen: no — roles are created in the UI.**
  The human: *"In v1 roles are fully created in the UI."* Req 5. Choosing a role's params means
  choosing among the services, models, harnesses and levels *this install* offers, and the UI is
  the only surface that can show that set.

- 2026-08-14 — **Must a role's params be pinned, or may ShipIt resolve them?** **Chosen:
  pinned.** Req 7, with the shipped reviewer the single exception — see the reviewer receipt
  above.

- 2026-08-14 — **May a role be overridden when it is started?** **Chosen: no — a role is a
  unit.** Req 10, which covers every parameter that says what to run on, not only a
  model or a level.

- 2026-08-14 — **Does a role carry a standing prompt?** **Chosen: yes, optional.** Req 8. A separate short description (req 9)
  says what a role is for whether or not it carries standing instructions.

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
  access to the inventory" → reqs 12 and 15.
- "Leave it implemented, but remove from the injected documentation." → req 14.
- "I think there should be two ways to run a sub-agent. One is as a review and another as a child
  session. So maybe in the child session API, the agent should be able to specify the role." →
  req 10.

- "I'm not sure if we need to keep the special casing of the reviewer role. What do you think?",
  and then "ok good" to the recommendation → req 2's shape. The question is his; that the answer
  is *one kind of role with automatic params on one of them*, rather than either "two kinds" or
  "no exception", came out of answering it.

Reqs 7 and 10 are his answers to questions put to him, recorded above. Reqs 13 and 14 are the
agent's — req 13 because a name-space open to user-defined names must fail legibly, and req 14
because attribution is an obligation ShipIt already has and this feature must not lose it — and
they are open question 3 rather than settled, because a requirement nobody asked for should be
struck rather than inherited by default. Req 9 is the agent's too, and is a consequence of req 12
rather than a new want: an agent cannot choose between roles it can only see the names of.
