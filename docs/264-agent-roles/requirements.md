---
issue: planning#363
title: Agent roles — requirements
description: User-defined agent roles — the params a reviewer has today and an optional prompt — invoked by name.
---

# 264 — Agent roles: requirements

**These are the things this feature changes. Everything ShipIt already does is a requirement
too, and is not restated here** — existing behaviour must keep working at least as well as it
does today.

This feature exists because an agent run is today either **implicit** (`--role reviewer`,
resolved from the two configured slots — docs/261), or spelled out **ad hoc** per review
(`--model NAME` / `--effort LEVEL` — docs/263). The direction generalizes the implicit side:
instead of only a reviewer, the user preconfigures **agent roles** — named units of agent work,
each carrying the params a reviewer has today (the service, the billing mode, the model and the
reasoning level), **the harness that runs it**, and an optional standing prompt. The **reviewer is
one role** (the automatic one); user roles are additional, and asking for a review and asking for
any other role are the same action.

The number of roles is **open-ended** ("preconfigure various agent roles"). A user role's params
are **pinned** (req 12); the automatic resolution is the built-in `reviewer` role's, and a user
role never resolves its own model.

## Requirements

1. **A user can create any number of agent roles**, and each role is a **complete** unit — the
   service, the billing mode, the model, the reasoning level **and the harness** (req 9).
   Nothing about a role's params is left for the agent to decide at invocation time, and nothing
   is left for ShipIt to derive at run time either.

2. **The reviewer is a role like any other.** The built-in `reviewer` role is the automatic
   one — it resolves from the configured slots, unchanged (docs/261 reqs 4, 8) — and asking for
   a review and asking for any other role are the same action: name the role. A user role may be
   a reviewer (with or without a review prompt) or any other job.

3. **A role is invoked by name, and the agent works out which role the user means.** "Review the
   PR" reaches the `reviewer` role without the user naming it; "review with `deep-dive`" names a
   role explicitly, and that name is used as given rather than re-interpreted. Both are the same
   action: **the agent supplies a role, never a param.** Mapping an intent to a role is the
   agent's job — it is the thing it has always done when it turned "review this" into
   `--role reviewer` — and choosing what that role runs on remains the user's (req 1).

4. **Invoking a role by name is at least as easy as spelling its work out ad hoc.** A role
   called `deep-dive` is invoked in one word, or in no word at all when the intent is plain
   enough for req 3 to resolve it. This is what makes the *sustainable* path (set up once,
   invoke by name) the *easy* path — the affordance that shapes the habit.

5. **Roles are created and edited in ShipIt's settings UI.** In v1 the UI is where a role comes
   from: it is the surface that can show the user what services, models and reasoning levels
   their install actually offers, which is exactly what choosing a role's params requires.

6. **A user can ask for a one-off combination without saving it**, by naming what they want in
   chat — the model and the level, relayed verbatim (docs/263). That is the path a role is later
   saved *from*: you cannot save a reviewer you have not tried. This requirement names the
   **user-supplied override** specifically; the fully-explicit five-flag `agent run` is a
   different thing and is **not** relied on here — see the 2026-08-14 finding under *Resolved
   questions*, and open question 2.

7. **Recurrence converts.** When the same combination recurs, ShipIt **offers** to save it as a
   role, and the user decides. An offer is never a forced action and never an interruption of
   the run itself.

8. **An unknown role name is refused, and the refusal names the known ones** — the built-in
   roles and the user's. The name is resolved server-side; the user is told what they can say
   next rather than what they did wrong. This mirrors the model-name resolution docs/263
   established.

9. **A role names its harness, and the harness is required.** A role carries
   `(harness, service, billing mode, model, level)`. It is not derived, not optional and not
   re-decided per run: a role is a *job definition*, and which agent performs the job is part of
   the job — Claude Code driving a model and Codex driving the same model are different agents,
   with different scaffolding, tools and agentic loops.

   **This is a deliberate departure from docs/261 req 3 for roles, and only for roles.** That
   requirement makes a reviewer a model with the harness *derived*, and the built-in `reviewer`
   role keeps that behaviour untouched (req 2). A user-defined role does not: it is the one place
   in ShipIt where the harness is chosen rather than derived, because it is the one place where
   the user is describing a job rather than picking a model.

   A role whose harness cannot run its model is **refused when it is saved**, not silently
   repaired — the same treatment req 13 gives every other param.

10. **What a role's run did is reported and attributed exactly as any other review.**
    docs/261 req 9 is restated because this feature must not lose it: a role is still resolved
    and routed once, and the consult card still says which service, model, harness and level
    actually ran.

11. **A role may carry an optional standing prompt — its job description — which composes with
    the per-invocation task prompt at run time.** The prompt is user data stored with the role,
    and the run's prompt is one channel: the role's standing half first, then the task half.
    A role without a prompt is a complete role; the prompt extends, it does not gate.

12. **A role names exactly what it runs.** A user role's params are **pinned**; the automatic
    resolution is the built-in `reviewer` role's, and a user role never resolves its own model.
    This settles the earlier "pool" question: user roles are not members of the automatic pick.

13. **A role is a unit; it is not overridden per invocation.** `--role NAME` combined with
    `--model` or `--effort` is refused, exactly as a role combined with an explicit parameter is
    refused today. A variation the user wants is a new role, which is the conversion this feature
    exists to encourage.

14. **The agent can see which roles exist.** It can read the roles this install has — their names
    and what each is for — so that it can map an intent to one (req 3), tell the user what is
    available when they ask, and name the alternatives when a role does not resolve (req 8).
    An agent that has to guess a role name is the same failure as an agent that has to guess a
    model: it produces a confident wrong answer the user cannot see the origin of.

    This is the **inventory** the current install does not give an agent at all — see the
    2026-08-14 finding. It is scoped to roles: nothing here requires exposing the whole service
    and model catalogue, which is req 5's job in the UI.

## Scope

This builds on docs/263's override machinery (an unmerged PR) and is designed for it, but does
not depend on it: `--role NAME` resolution for a user role reuses the same routable-target
machinery a pin uses today, so the feature can land alongside 263 or after it.

The **two configured slots** (docs/261) stay exactly as they are — they are the built-in
`reviewer` role's resolution. The previous design's separate `--reviewer NAME` namespace
(docs/264's earlier "named reviewer configurations" frame) is **folded into `--role NAME`**:
a named reviewer *is* a role.

**Chat-native role creation is out of scope for v1** (req 5). It was a requirement in an earlier
draft and was removed on the human's instruction; the reasoning is in the 2026-08-14 receipt.

## Open questions

1. **What happens to the fully-explicit five-flag `agent run`?** The human, on the ad-hoc path:
   *"today doesn't work at all because the agent has to specify all the params, and it does not
   have access to the inventory. So essentially this feature doesn't work. Maybe we could even
   remove it as part of this refactor, or leave for now."* The finding is confirmed (see the
   2026-08-14 receipt). **Recommended: leave it for now and do not build on it** — removing it is
   docs/261's territory and a separate change, and this feature depends on none of it. Worth
   deciding deliberately rather than by neglect, because a documented path nobody can use is a
   standing invitation for an agent to guess at it.

## Resolved questions

- 2026-08-14 — **May a role name a harness?** **Chosen: it must.** Offered as an *optional*
  constraint; the human went further — *"let's require it."* So the harness is part of a role's
  tuple rather than a field that may be absent (req 9), and a role is the one place in ShipIt
  where the harness is chosen instead of derived.

  Three consequences, recorded because required is a stronger claim than optional and two of them
  are not obvious:

  - **It takes user roles off docs/261 req 3's model-first line, deliberately.** The built-in
    `reviewer` keeps deriving (req 2); a user role does not. That is a departure a reader will
    otherwise mistake for an inconsistency, so req 9 states it outright. It does not reopen
    docs/261's 2026-08-10 receipt: *choosing a model* is still how you say what runs, everywhere
    else in the product.
  - **A required harness cannot silently move, and that is the point.** A derived harness
    re-derives as the install changes; a named one is frozen and goes `pin_unavailable` if the
    harness is uninstalled. For a job definition, being told "this role cannot run" is better
    than being quietly handed a different agent — which is precisely the "same model, different
    agent" difference that motivated requiring it.
  - **It dissolves a latent bug docs/261 deliberately left open.** That design records
    (`plan.md`, phase 3) that a pin's effort is validated against the *settings-time derived*
    harness while `selectReviewer` may run it on a **different** one, carrying a level the second
    harness may not declare — unreachable today, and fixable only by choosing between refusing
    the review and silently substituting a default. For a role there is no gap to fix: the level
    is validated against the one harness the role names, and that is the harness it runs on. The
    bug class does not exist here.

- 2026-08-14 — **Who picks the role — the user's exact word, or the agent's reading of the
  intent?** **Chosen: the agent works out which role is meant.** The human, of the draft's
  verbatim-courier rule: *"The agent should be able to figure out the correct role. E.g. 'review
  the PR' -> role == reviewer."* The draft had over-applied docs/263's courier invariant: that
  rule exists so an agent cannot invent a **model** or an **effort level** — values it has no way
  to know and no business choosing — and req 3 had stretched it to cover the role name too, which
  would have made "review the PR" un-actionable without the user reciting a role name. Rewritten:
  the agent maps intent to a role, passes an explicitly named role through unchanged, and still
  supplies **no param**. That is also the invariant docs/261 req 6 actually states — *name the
  role, never the reviewer* — so this restores the boundary rather than moving it. Req 14 exists
  because of this: an agent can only map an intent onto roles it can see.

- 2026-08-14 — **Is role creation chat-native?** **Chosen: no — in v1 roles are created in the
  UI.** The human: *"Remove this. In v1 roles are fully created in the UI."* The draft's req 5
  made a chat sentence the creation path. Removed, and the slot restated as the opposite: the UI
  is where a role comes from. The reasoning that supports it, recorded because it is why the
  instruction is right rather than merely followed — choosing a role's params means choosing
  among the services, models and levels *this install* offers, and the UI is the only surface
  that can show that set; a chat sentence would have the agent naming params it cannot enumerate,
  which is the same defect the next receipt records. Consequence for req 7: a recurrence offer
  points at the UI rather than writing a role itself (`plan.md`).

- 2026-08-14 — **Finding: the fully-explicit `agent run` path is unusable by an agent.** The
  human: *"today doesn't work at all because the agent has to specify all the params, and it does
  not have access to the inventory."* **Checked before recording, and it holds.** docs/261 req 7
  requires `--agent`, `--service`, `--billing-mode`, `--model` and `--effort` together, and
  refuses the call if any is missing; the session shim (`src/server/session/agent-shim/`) exposes
  `agent run` and `agent result` and **nothing that lists services, models, billing modes or
  effort levels** — there is no catalogue read anywhere in that tree. docs/261's own `plan.md`
  says as much in passing ("the agent inside a container has no way to discover a service, a
  billing mode or a valid effort level, so filling the five in would mean *guessing*"), which
  makes the path complete-by-construction and unreachable in practice. Its only real user is a
  repository that hard-codes all five (docs/261 req 2's override). Recorded as a finding rather
  than fixed here: req 6 is narrowed to the user-supplied override that does work, req 14 adds
  the inventory *for roles*, and what to do with the five-flag path is open question 2.

- 2026-08-14 — **May a role name a harness? — the first answer, withdrawn.** It was recorded as
  "no" on the human's one-word answer; he then asked why, and the reasons did not survive being
  written down: the real one was that no shipped model runs on both harnesses, so a picker would
  offer one option — an argument for not *rendering a control*, not for making the state
  inexpressible. Superseded the same day by the receipt above, which requires it. Kept because
  the reversal is the useful record: a flat answer that cannot justify itself is worth
  re-examining, and the design asserted a rule it would have had to break later.

- 2026-08-14 — **What triggers the recurrence offer? — withdrawn as mis-filed, not answered.**
  The human: "I don't understand the question." Checked before rewriting, and he is right that it
  was not a question for him: it asked whether the offer comes from the agent's own judgement or
  from a server-side detector, which is a **mechanism** the user cannot observe — both produce
  the same experience req 7 already fixes (the same combination recurs, ShipIt offers, the user
  decides). A requirements document is the wrong place for it, and putting it there asked the
  human to ratify an implementation choice. It is removed rather than rephrased, and the decision
  now lives in `plan.md` § "Recurrence conversion" as design, where it can be judged on whether it
  delivers req 7. Nothing about req 7 changes.

  The UX-level question that *would* have been his — should ShipIt offer at all, and does the
  user decide — is already req 7, answered before this was ever asked.

- 2026-08-14 — **Generalize reviewers to agent roles.** The human, of the earlier "named
  reviewer configurations" frame: "How about we generalize reviewers to any agent roles? So
  essentially the user would be able to preconfigure various agent roles, where it would be the
  params we have now and maybe also some prompt." **Chosen: a role is the unit.** The reviewer
  is one role (the automatic one, docs/261 unchanged); user roles are additional named units
  carrying the params a reviewer has today, invoked by `--role NAME`; the earlier `--reviewer
  NAME` namespace folds into the role namespace. The "maybe also some prompt" became a settled
  requirement the same day — see the prompt receipt below. The re-reading of docs/261 req 6 this
  implies ("the agent names the role, never the reviewer" — a user role *is* a reviewer the user
  named) is recorded in `plan.md` § "The shape".

- 2026-08-14 — **Does a role carry a standing prompt?** **Chosen: yes, optional.** The human took
  the recommendation. Req 11.
- 2026-08-14 — **Must a user role's params be pinned, or may they be auto (ShipIt-resolved)?**
  **Chosen: pinned.** The human took the recommendation. Req 12, which settles the earlier pool
  question.
- 2026-08-14 — **May `--role NAME` combine with per-invocation `--effort` / `--model`
  overrides?** **Chosen: no — a role is a unit.** The human took the recommendation. Req 13.

## Requirement provenance

This feature exists because of the direction the product owner described, relayed by the parent
session's mission and refined by the human directly. Most of the shape is his framing, and where
a requirement is a restatement of docs/261/263 it is marked as such. What he actually said:

- "add as many named reviewer configurations as they want and invoke one by name ('review with
  `deep-dive`')" → reqs 1 and 3, in the earlier frame.
- "invocation by name is at least as short as the ad-hoc spelling" → req 4.
- "convert novelty into assets … the easiest path becomes the habit — so the sustainable path
  must be the easy path" → req 4, and the shaping principle behind reqs 6 and 7.
- "Keep the ad-hoc path as the *discovery on-ramp* (you cannot save a reviewer you have not
  tried) and make **conversion** the mechanism — not prohibition" → reqs 6 and 7.
- "the same (model, effort) combo requested twice triggers an offer to save it as a named
  reviewer (the propose-actions pattern)" → req 7, with the mechanism — including what notices
  the recurrence — left entirely to `plan.md`.
- **"generalize reviewers to any agent roles … the params we have now and maybe also some
  prompt"** → reqs 1, 2 and 3, and the receipt above. This superseded the "named reviewer" frame.
- **"The agent should be able to figure out the correct role. E.g. 'review the PR' -> role ==
  reviewer."** → req 3's rewrite, and req 14, which is what makes it possible.
- **"Remove this. In v1 roles are fully created in the UI."** → req 5, inverted from the draft.
- **"today doesn't work at all because the agent has to specify all the params, and it does not
  have access to the inventory"** → req 6's narrowing, req 14, and open question 2. The
  observation is his; the verification against the shim is recorded in the receipt.
- **"So help me understand why the user shouldn't be able to select the harness."** and, on the
  optional constraint that answer produced, **"let's require it."** → req 9. Both moves are his:
  the challenge that reopened it, and the decision to go past the recommendation from optional to
  required.

Reqs 8 and 10 restate existing rules the feature must not lose: docs/263's name resolution (8)
and docs/261 req 9 (10). Reqs 9 and 11–13 are the human's answers, each with a dated receipt
above. Req 14 is the agent's, and it is the one requirement here that exists because a *defect*
was found rather than because a behaviour was asked for.

**Req 9 is the one requirement that departs from docs/261 rather than restating it**, and it does
so on the human's explicit instruction. Everything else in this document inherits docs/261's
rules; this one deliberately does not, for user roles only.
