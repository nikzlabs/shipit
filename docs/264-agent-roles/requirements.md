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
reasoning level) and an optional standing prompt. The **reviewer is one role** (the automatic one);
user roles are additional, and asking for a review by name and asking for any other role by name
are the same action.

The shaping principle, in the product owner's words: *the ad-hoc path stays as the discovery
on-ramp — you cannot save a reviewer you have not tried — and conversion is the mechanism, not
prohibition.* Nothing here blocks, warns at, or otherwise makes the ad-hoc path harder.

The number of roles is **open-ended** ("preconfigure various agent roles"). A user role's params
are **pinned** (req 12); the automatic resolution is the built-in `reviewer` role's, and a user
role never resolves its own model.

## Requirements

1. **A user can create any number of agent roles**, and each role is a **complete** unit — the
   service, the billing mode, the model and the reasoning level — exactly the tuple a pinned
   reviewer holds today (docs/261 reqs 1, 3, 5). Nothing about a role's params is left for the
   agent to decide at invocation time.

2. **The reviewer is a role like any other.** The built-in `reviewer` role is the automatic
   one — it resolves from the configured slots, unchanged (docs/261 reqs 4, 8) — and asking for
   a review and asking for any other role are the same action: name the role. A user role may be
   a reviewer (with or without a review prompt) or any other job.

3. **A user invokes a role by naming it** — "review with `deep-dive`", "run the `spec-check`
   role" — and the run uses that role. The name travels from the user to ShipIt **verbatim**:
   the agent passes it through and never chooses or invents it, the same courier invariant
   docs/263 applies to `--model` and `--effort`.

4. **Invoking a role by name is at least as easy as spelling its work out ad hoc.** A role
   called `deep-dive` is invoked in one word where the same work without it costs a model name
   and a level. This is what makes the *sustainable* path (set up once, invoke by name) the
   *easy* path — the affordance that shapes the habit.

5. **Creating a role is chat-native**: "create a role `spec-check` that checks the code against
   requirements.md, using GPT-5.6 at low effort" is a sentence, not a Settings excursion.
   Settings may show and edit roles, but it is not required to create one.

6. **The ad-hoc path stays, unchanged, as the on-ramp.** Naming a model and a level for a single
   run keeps working exactly as it does today, and ShipIt neither blocks it nor nudges it except
   by conversion (req 7). The moment a combination is worth keeping is the moment a role can
   exist for it — which is only possible *after* the combination has been tried ad hoc.

7. **Recurrence converts.** When the same combination recurs, ShipIt **offers** to save it as a
   role, and the user decides. An offer is never a forced action and never an interruption of
   the run itself.

8. **An unknown role name is refused, and the refusal names the known ones** — the built-in
   roles and the user's. The name is resolved server-side; the user is told what they can say
   next rather than what they did wrong. This mirrors the model-name resolution docs/263
   established.

9. **A role is a model, like every other reviewer; the harness is derived, and a role never
   names one.** docs/261 req 3 fixes a reviewer as a model with the harness derived from it, and
   a role is a reviewer. A role carries `(service, billing mode, model, level)` and nothing about
   which CLI runs it — so there is one way to select what an agent runs on, everywhere.

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

## Scope

This builds on docs/263's override machinery (an unmerged PR) and is designed for it, but does
not depend on it: `--role NAME` resolution for a user role reuses the same routable-target
machinery a pin uses today, so the feature can land alongside 263 or after it.

The **two configured slots** (docs/261) stay exactly as they are — they are the built-in
`reviewer` role's resolution. The previous design's separate `--reviewer NAME` namespace
(docs/264's earlier "named reviewer configurations" frame) is **folded into `--role NAME`**:
a named reviewer *is* a role.

## Open questions

_None._

## Resolved questions

- 2026-08-14 — **May a role name a harness?** **Chosen: no.** The human, in one word, on the
  recommendation. Req 9 now states it as a property of a role rather than deferring it: a role
  carries `(service, billing mode, model, level)` and the harness is derived. This holds
  docs/261's model-first line (its 2026-08-10 receipt, "unify on model-first") for the surface
  most likely to have reopened it — the original ask for this feature *did* include a harness
  axis, and it is now answered rather than left implied.

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
  requirement the same day — see the prompt receipt above. The re-reading of docs/261 req 6 this implies
  ("the agent names the role, never the reviewer" — a user role *is* a reviewer the user named)
  is recorded in `plan.md` § "The shape".

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
- "'save a reviewer called `deep-dive` = GPT-5.6 at high effort' is a sentence, not a Settings
  excursion" → req 5.
- "convert novelty into assets … the easiest path becomes the habit — so the sustainable path
  must be the easy path" → req 4, and the shaping principle in the preamble.
- "Keep the ad-hoc path as the *discovery on-ramp* (you cannot save a reviewer you have not
  tried) and make **conversion** the mechanism — not prohibition" → reqs 6 and 7.
- "the same (model, effort) combo requested twice triggers an offer to save it as a named
  reviewer (the propose-actions pattern)" → req 7, with the mechanism — including what notices
  the recurrence — left entirely to `plan.md`.
- **"generalize reviewers to any agent roles … the user would be able to preconfigure various
  agent roles, where it would be the params we have now and maybe also some prompt"** → reqs 1,
  2 and 3, and the resolved receipt above. This is the decision that superseded the "named
  reviewer" frame.

Reqs 8, 9 and 10 are the agent's, each a restatement of an existing rule the feature must not
lose: docs/263's model-name resolution (8), docs/261 req 3 (9), and docs/261 req 9 (10). Req 8
is stated because name resolution over the *role* namespace — now open to user-defined names —
is the genuinely new failure mode this feature introduces, and it must fail as legibly as
docs/263's does.

Reqs 11–13 are the human's answers to the open questions, each taken as recommended and
recorded with a dated receipt above: the standing prompt (11), pinned params (12), and a role as
an unoverridable unit (13). Req 9's harness clause is his too — a one-word "no" that turned a
deferred question into a stated property.

**No open questions remain.** One was withdrawn rather than answered, because it asked the human
to choose a mechanism he could not observe; the receipt above records that, since a question that
disappears without a reason is indistinguishable from one that was quietly decided.
