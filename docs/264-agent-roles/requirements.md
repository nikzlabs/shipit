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
runs it, the model it runs (a service, a billing mode and a model id) and the reasoning level,
and optionally a description and standing instructions describing the job. An agent starts a role
**by name**; where the user wants a variation, it may override any parameter the role carries.

There is one kind of role. What a role's params may be is where the only variation lives: the
user pins them (req 1), and ShipIt ships one role — the reviewer — whose params it resolves
instead (req 2).

## Requirements

1. **A user can create any number of agent roles**, and each role is a **complete** unit — the
   harness, the service, the billing mode, the model and the reasoning level. A role is complete
   on its own: starting one needs nothing added to it.

2. **The reviewer is a role, and it is the one role whose params ShipIt resolves.** Asking for a
   review and asking for any other role are the same action: name the role. What sets the
   reviewer apart is not its kind but its params — they are **automatic** rather than pinned, so
   that:

   - a review is never performed by the model that produced the work, whenever any alternative
     is available — this is what automatic params buy, and it is **set aside when the caller
     overrides the reviewer** (req 10), because the caller has then said what they want;
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
   role explicitly, and that name is used as given rather than re-interpreted. Mapping an intent
   onto a role is the agent's judgement; what that role runs on is the user's (req 1).

   **A name is all the agent needs to supply.** Where the user asked for a variation the agent
   relays it as an override (req 10); what the agent may never do is *assemble* a target of its
   own choosing, whether by inventing an override or by naming every parameter from scratch. A
   repository that holds a complete target of its own may still hand one over to be passed through
   unchanged, which is a different invocation and stays available (req 15).

4. **Starting a role costs a name.** A role is invoked in one word, or in no word at all when the
   intent alone resolves it (req 3). Nothing else has to be restated at the moment of use — that
   is what the role was configured for. A caller that wants a variation may say so (req 10), but
   it is never required to.

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

7. **A role runs what it names, and ShipIt never substitutes anything for it.** Resolution does
   not quietly swap a model, a harness or a level — a role that cannot run says so rather than
   running on something else. Two things are not substitutions and are allowed: the reviewer's
   params, which ShipIt resolves by design (req 2), and an override the caller asked for
   (req 10), which is visible in the request that made it.

   This governs **resolution**. What a child session does over its own life afterwards is req 11's
   subject, and the two are deliberately different: a role hands a child its starting tuple and
   stops being involved.

8. **A role may carry standing instructions — what the job is — which apply whenever the role is
   started, in addition to the task it is given.** A role without them is a complete role.

9. **A role may say what it is for**, in a short description the agent and the user can both
   read. It is optional, like standing instructions — a role without one is complete, and the
   agent falls back to the name.

10. **A role may be overridden when it is started, in any parameter it carries** — the harness,
    the service, the billing mode, the model, the reasoning level. The role supplies everything
    not overridden. Wanting a variation is common enough that requiring a whole second role for
    it would be the wrong trade.

    **Overriding the reviewer sets aside its guarantees.** A reviewer run that is not overridden
    still avoids the model that produced the work (req 2). Once the caller overrides it, no promise
    survives that the review runs on anything different — the caller has named what they want, and
    ShipIt does not overrule them or quietly refuse. It stays visible in the request that made it.

    **An override comes from the user, and the agent relays it rather than choosing it.** This is
    the line that has to survive: an agent may carry "review this with Opus at high effort"
    because the user said so, and may not decide on its own which model or level a run deserves.
    A value the agent invented and a value the user asked for are indistinguishable once they
    reach ShipIt, so the rule lives in what the agent is told rather than in what ShipIt can
    detect.

11. **A role can be used for either way of starting an agent: a one-shot run, or a child
    session.** These are the two shapes a sub-agent takes — a consult that returns its output to
    the caller, and a session with its own branch and pull request — and a role names what runs,
    which is the same question in both. A child session started with a role runs that role
    completely, rather than inheriting its parent's harness and model.

    **A role decides what the child starts as, not what it is bound to for ever.** Once created,
    such a child is an ordinary session: it keeps the routing, account failover and
    model-retirement behaviour every other session has, and may over time run on something other
    than what the role named. Editing or deleting the role afterwards does not reach back into a
    child that already exists.

12. **The agent can see what it is allowed to name — both the roles and the parameters.** It can
    read this install's roles (their names, and what each is for — req 9) so it can map an intent
    onto one (req 3) and tell the user what exists; and it can read the parameters that are
    actually available here — the models, the harnesses, the reasoning levels — so that an
    override (req 10) names something real.

    **This is what makes overriding safe rather than a licence to guess.** An override the agent
    cannot check is a guess, and a guessed parameter is indistinguishable from one the user
    supplied. Allowing overrides and withholding the list would be the worst of both: the agent
    would fill the gap from memory, naming models this install does not have. So the two go
    together — the ability to name a parameter, and the ability to see which parameters exist.

13. **An unknown role name is refused, and the refusal names the roles that do exist.** The name
    is resolved server-side, and the user is told what they can say next rather than what they
    did wrong.

14. **What a role's run did is reported and attributed** — the service, the model, the harness
    and the level it actually ran on, with its usage and cost attributed to the service and
    billing mode that served it. This holds for both ways of starting a role (req 11), and a child
    session also records which role started it.

15. **A role is the path ShipIt teaches; naming every parameter from scratch is not.** The
    instructions ShipIt injects do not present starting an agent by assembling a harness, a
    service, a billing mode, a model and a level together — a role, with an override where one is
    wanted (req 10), does the same job in less and keeps what runs anchored to something the user
    configured. That path remains implemented, and remains documented for the humans and
    repositories that hold a complete target of their own.

16. **The two ways of starting an agent have the same API surface.** A one-shot run and a child
    session accept the same things in the same way: a role, a role with **any subset** of its
    parameters overridden (req 10), or a complete target naming every parameter.

    **Partial is the normal case, not a special one.** A caller names the parameters it cares
    about and nothing more, in both commands alike. What may not be partial is a call with nothing
    to complete it from: naming neither a role nor a parent, and only some parameters, leaves
    ShipIt guessing at the rest, and that is refused.

    A child session therefore keeps what it can already do — naming one parameter and taking the
    rest from its parent — because a parent is something to complete from, exactly as a role is.
    That is the one place the two commands differ, and only because a one-shot run has no parent.

    Today they differ far more than that — a child session can name only a harness and a model,
    so it cannot express a complete target at all, and its service, billing mode and reasoning
    level are not sayable. Two commands answering the same question in two vocabularies is what
    this removes.

17. **A role is edited in its own editor, not in a row of inline controls.** A role has a name, a
    description, standing instructions and the parameters it runs on; opening it gives one place
    to edit all of them together.


## Scope

A role covers **what an agent runs on** and, optionally, **what job it is for**. It does not
cover when a role is used, which is the agent's judgement (req 3), or what any given run is
asked to do, which arrives with the run.

Roles are configured in ShipIt and apply to every session and repository, in the way ShipIt's
other agent settings already do.

## Open questions

_None._

## Resolved questions

- 2026-08-15 — **When the reviewer is overridden, does the promise that it avoids the implementing
  model still hold?** **Chosen: no — an override sets the guarantee aside.** The human: *"When
  there is an override, any guarantees about the model being different are off."*

  Reqs 2 and 10 now say so in both directions: an un-overridden reviewer run still avoids the model
  that produced the work, and an overridden one carries no such promise. This dissolves the
  conflict rather than balancing it — ShipIt does not overrule the caller, and does not refuse them
  either.

  The cost, accepted: a user can ask for a review by the model that just wrote the code, and get
  one. That is the same trade every override makes — the caller's stated wish beats ShipIt's
  default — and it is the reason the bare `reviewer` role stays the shortest thing to type.

- 2026-08-15 — **Does a child session keep naming one parameter and inheriting the rest?**
  **Chosen: yes — partial is the normal case in both commands.** The human: *"when we create a
  child session or a sub-agent with a role, in both cases we should be able to partially override
  any of the params."*

  Req 16 was the thing at fault, not the child: its "one set of refusals" swept up a shape docs/261
  req 10 deliberately guarantees. Rewritten so that **partial is ordinary** and what is refused is
  narrower — a call with nothing to complete itself from, naming neither a role nor a parent and
  only some parameters.

  **One reading recorded as a reading:** the words above are about the role path, and the bare
  `session create --model X` with no role named is not literally mentioned. It is kept, because a
  parent completes a partial call exactly as a role does, so treating them alike is what makes the
  two commands one surface — and because removing shipped behaviour was never asked for.

- 2026-08-14 — **May a role be overridden when it is started, and do the two commands share one
  API surface?** **Chosen: yes to both — a role may be overridden in any parameter, and the two
  commands are the same surface.** The human: *"I feel like sub-agents and children should have
  the same API surface, and we probably cannot avoid overriding parameters. So let's say that a
  role can be overridden by any modification, which would include the model, the harness, thinking
  level, whatever there is. And so we need to make sure that the agent knows what are the params
  available."*

  This **reverses** an earlier decision that a role is a unit and an override is refused. Reqs 4,
  7, 10 and 16 are rewritten accordingly.

  **What it did not settle**, recorded because it was briefly mistaken for a decision: whether the
  existing bare `session create --model X` — no role, some parameters, the rest inherited from the
  parent — survives. The words above approve *role* overrides on both commands and say nothing
  about that form. Settled separately the next day; see the partial-override receipt above.

  **The third sentence is the load-bearing one, and it is why this is coherent rather than a
  loosening.** Overrides and the parameter inventory arrive together: an agent that may name a
  model but cannot see which models exist would fill the gap from memory, and a remembered model
  is indistinguishable from a supplied one by the time it reaches ShipIt. Req 12 therefore grows
  from roles-only to roles-and-parameters, reversing a boundary this document had drawn twice.

  **What survives, stated because it is now the only thing standing between this and an agent
  choosing models for itself:** an override is *the user's*, relayed. The agent may carry "review
  this with Opus at high effort" and may not decide that a run deserves a different model. ShipIt
  cannot tell the two apart, so the rule lives in what the agent is told (req 10).

- 2026-08-14 — **What happens to a role whose model is retired?** **Chosen: the role stops working
  and says so, and the user re-points it in Settings.** The human agreed with the recommendation.
  Req 7 stands as written: resolving a role never substitutes a different model. The cost is
  accepted — a retirement can leave a role broken until someone edits it, where a reviewer pin
  would have carried on.

- 2026-08-14 — **What may a role be named?** **Chosen: any name the user types, with only
  uniqueness enforced.** The human agreed with the recommendation. No token shape, no case rule,
  no length rule beyond what storage needs; a name that needs quoting on a command line is quoted.

- 2026-08-14 — **Do reqs 9, 13 and 14 stand?** **Chosen: yes, all three — with req 9 weakened to
  optional.** The human agreed to each, and of the description: *"agree, but optional."* So a role
  may say what it is for and need not; the agent falls back to the name. The provisional markers
  are removed and all three are ordinary requirements.

- 2026-08-14 — **Unify the two spawn APIs.** The human: *"need to unify the 'child spawn' and
  'sub-agent within the session' spawn api. Both should be able to take roles, but a child spawn
  is now more flexible, allowing overriding a model, for example. This is convenient, but becomes
  inconsistent with the sub-agent changes."* Req 16. Checked rather than assumed: `session create`
  accepts only `--agent` and `--model` and forwards them as bare values, so a child session cannot
  express a service, a billing mode or a reasoning level at all — the two commands answer the same
  question in two different vocabularies, and unifying them *adds* to the child rather than only
  constraining it. How far the unification goes was settled the same day — see the override
  receipt above.

- 2026-08-14 — **How is a role edited?** **Chosen: a dedicated role editor, not inline controls.**
  The human: *"Need a separate 'role editor dialog' instead of inline dropdowns like it is now, to
  edit name, description, prompt."* Req 17. A role carries a name, a description, standing
  instructions and five parameters, which is more than a row of dropdowns can hold legibly.

- 2026-08-14 — **Should the reviewer keep behaving differently from every other role?** **Chosen:
  keep the behaviour, drop the framing.** Put to the human as a real choice, with the cost of the
  alternative stated; he took the recommendation — *"ok good."*

  So there is **one kind of role**, and the variation lives in a role's params: a user pins them
  (req 1), and ShipIt ships one role whose params it resolves (req 2). The reviewer is not a
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
  agent may choose a *role*; it may never choose a model or a level on its own. **Partly
  superseded** by the override receipt at the top of this list: the agent may now carry a
  parameter the user named, and can enumerate the parameters this install offers (req 12). What
  survives unchanged is the line between relaying a value and deciding one.

- 2026-08-14 — **Is role creation chat-native?** **Chosen: no — roles are created in the UI.**
  The human: *"In v1 roles are fully created in the UI."* Req 5. Choosing a role's params means
  choosing among the services, models, harnesses and levels *this install* offers, and the UI is
  the only surface that can show that set.

- 2026-08-14 — **Must a role's params be pinned, or may ShipIt resolve them?** **Chosen:
  pinned.** Req 1, with the shipped reviewer the single exception — see the reviewer receipt
  above.

- 2026-08-14 — **May a role be overridden when it is started?** **Chosen: no — a role is a
  unit.** **Superseded the same day** by the override receipt at the top of this list, which
  reverses it. Kept because the reversal is only legible next to what it reversed.

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
- "Leave it implemented, but remove from the injected documentation." → req 15.
- "I think there should be two ways to run a sub-agent. One is as a review and another as a child
  session. So maybe in the child session API, the agent should be able to specify the role." →
  req 11.

- "I'm not sure if we need to keep the special casing of the reviewer role. What do you think?",
  and then "ok good" to the recommendation → req 2's shape. The question is his; that the answer
  is *one kind of role with automatic params on one of them*, rather than either "two kinds" or
  "no exception", came out of answering it.

- "need to unify the 'child spawn' and 'sub-agent within the session' spawn api. Both should be
  able to take roles, but a child spawn is now more flexible, allowing overriding a model … This is
  convenient, but becomes inconsistent with the sub-agent changes." → req 16. He resolved the
  tension he identified here in the same session, by making overrides general rather than
  removing them.
- "Need a separate 'role editor dialog' instead of inline dropdowns like it is now, to edit name,
  description, prompt." → req 17.
- "agree, but optional" (of the description) → req 9's optionality.
- "sub-agents and children should have the same API surface, and we probably cannot avoid
  overriding parameters … a role can be overridden by any modification, which would include the
  model, the harness, thinking level, whatever there is. And so we need to make sure that the
  agent knows what are the params available." → reqs 10, 12 and 16, and the rewrites of reqs 4
  and 7. The pairing of the two halves — overrides *and* an inventory — is his, and it is what
  keeps the override from being a licence to guess.
- "When there is an override, any guarantees about the model being different are off." → the
  carve-out in req 2 and the second paragraph of req 10.
- "when we create a child session or a sub-agent with a role, in both cases we should be able to
  partially override any of the params" → req 16's rewrite. He read the refusal as the defect
  rather than the child's behaviour, which is what turned a blocking contradiction into a
  narrowing.

Reqs 7 and 10 are his answers to questions put to him, recorded above.

**Reqs 9, 13 and 14 originated with the agent** rather than with anything he said, and all three
were put to him and agreed — req 9 with the modification that it is optional. They are ordinary
requirements now; the provenance is recorded because where a requirement came from should stay
legible after it is approved.
