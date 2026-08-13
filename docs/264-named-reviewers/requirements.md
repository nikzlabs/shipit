---
issue: planning#363
title: Named reviewer configurations — requirements
description: Reusable, named reviewer setups a user invokes by name, with the ad-hoc path as the on-ramp.
---

# 264 — Named reviewer configurations: requirements

**These are the things this feature changes. Everything ShipIt already does is a requirement
too, and is not restated here** — existing behaviour must keep working at least as well as it
does today.

This feature exists because a reviewer can today be either **implicit** (`--role reviewer`,
resolved from the two configured slots — docs/261) or spelled out **ad hoc** per review
(`--model NAME` / `--effort LEVEL` — docs/263). Spelling a reviewer out is a *novelty* that is
spent each time. The direction is to **convert novelty into assets**: a reviewer combination the
user has asked for becomes a named, reusable configuration, and asking for a review by name gets
at least as easy as spelling it out again.

The shaping principle, in the product owner's words: *the ad-hoc path stays as the discovery
on-ramp — you cannot save a reviewer you have not tried — and conversion is the mechanism, not
prohibition.* Nothing here blocks, warns at, or otherwise makes the ad-hoc path harder.

The count of named configurations is **open-ended** ("add as many … as they want"). Whether the
named configurations join the implicit `--role reviewer` pool is deliberately **not** decided
here — see open question 1. Everything below holds either way.

## Requirements

1. **A user can create any number of named reviewer configurations**, and each one is a
   **complete** reviewer — the service, the billing mode, the model and the reasoning level —
   exactly the tuple a pinned reviewer already holds (docs/261 reqs 1, 3, 5). Nothing about a
   named configuration is left for the agent to decide at invocation time.

2. **A user invokes a review with a named configuration by naming it** — "review with
   `deep-dive`" — and the review runs that configuration. The name travels from the user to
   ShipIt **verbatim**: the agent passes it through and never chooses or invents it, the same
   courier invariant docs/263 applies to `--model` and `--effort`.

3. **Invoking by name is at least as easy as spelling the reviewer out ad hoc.** A configuration
   called `deep-dive` is invoked in one word where the same review without it costs a model name
   and a level. This is what makes the *sustainable* path (set up once, invoke by name) the
   *easy* path — the affordance that shapes the habit.

4. **Creating a named configuration is chat-native**: "save a reviewer called `deep-dive` =
   GPT-5.6 at high effort" is a sentence, not a Settings excursion. Settings may show and edit
   them, but it is not required to create one.

5. **The ad-hoc path stays, unchanged, as the on-ramp.** Naming a model and a level for a single
   review keeps working exactly as it does today, and ShipIt neither blocks it nor nudges it
   except by conversion (req 6). The moment a combination is worth keeping is the moment a named
   configuration can exist for it — which is only possible *after* the combination has been tried
   ad hoc.

6. **Recurrence converts.** When the same reviewer combination recurs, ShipIt **offers** to save
   it as a named configuration, and the user decides. An offer is never a forced action and never
   an interruption of the review itself.

7. **An unknown name is refused, and the refusal names the known ones.** The name is resolved
   server-side; the user is told what they can say next rather than what they did wrong. This
   mirrors the model-name resolution docs/263 established.

8. **A named configuration is a model, like every other reviewer; the harness is derived.**
   docs/261 req 3 fixes a reviewer as a model with the harness derived from it, and a named
   configuration is a reviewer. Whether a named configuration may *additionally* name a harness is
   open question 2.

9. **What a named review ran on is reported and attributed exactly as any other review.**
   docs/261 req 9 is restated because this feature must not lose it: a named configuration is
   still resolved and routed once, and the consult card still says which service, model, harness
   and level actually ran.

## Scope

This builds on docs/263's override machinery (an unmerged PR) and is designed for it, but does
not depend on it: `--reviewer NAME` resolution reuses the same routable-target machinery a pin
uses today, so the feature can land alongside 263 or after it.

The **two configured slots** (docs/261) are untouched by the minimum shape of this feature.
Whether named configurations later join the slot pool is open question 1.

## Open questions

1. **Do named configurations join the implicit `--role reviewer` pool?** Two shapes were
   explored: **extend** — the two slots stay the "auto" reviewers, named configurations are
   invoked explicitly only; and **unify** — the named set *is* the reviewer pool, the bare
   `--role reviewer` ranks across all of them (a saved configuration can win the automatic pick),
   and naming one is explicit choice. **Recommended: extend now, and design the storage and
   ranking list-shaped so the unify fold is a small later change.** The assessment is in
   `plan.md` § "The shape decision": unify's headline benefit — "adding a configuration improves
   the auto-pick" — is largely illusory in practice, because the derived default is already
   distance-optimal and a user's chosen configuration rarely beats it on the distance criterion;
   and its real cost reworks docs/261's shipped two-slot storage, settings payload, Reviewer tab
   and tests for a benefit that is mostly one-mental-model cleanliness. Extend delivers the
   stated experience (reqs 1–7) at a fraction of the cost. The human may still want the fold; it
   is the decision this question exists for.

2. **May a named configuration name a harness?** docs/261 deferred harness naming for reviewers
   (req 3, unify on model-first). The original user ask for this feature *included* a harness
   axis. **Recommended: no — a named configuration carries `(service, billing mode, model,
   level)` and the harness stays derived**, consistent with req 8 and with every other reviewer.
   Reversing model-first for named configurations only would make the harness a second
   configuration axis with no first-class status anywhere else.

3. **May `--reviewer NAME` combine with per-invocation `--effort` / `--model` overrides?**
   A named configuration is a complete unit (req 1), so a "same configuration, different level"
   call is really a new combination — which the ad-hoc path already expresses.
   **Recommended: no — combining is refused**, exactly as a role combined with an explicit
   parameter is refused today. The variation a user wants is a cue to save *another* named
   configuration, which is the conversion this feature exists to encourage.

4. **What triggers the recurrence offer?** **Recommended: the agent's own judgement, using the
   propose-actions pattern**, rather than a server-side heuristic. The agent is the courier of
   every reviewer request, so it is the surface that can see "the user has asked for GPT-5.6 at
   high effort twice" — and an offer is a turn-shaped action, which is the agent's to make, not a
   server's to inject. A server-side detector (scanning consult history for repeated `runOn`
   tuples) would duplicate that sight in a place that cannot act on it.

## Resolved questions

_None yet — this is a design exploration; every decision above awaits the human, and the receipts
will land here as they are made._

## Requirement provenance

This feature exists because of the direction the product owner described, relayed by the parent
session's mission. Most of the shape is his framing, and where a requirement is a restatement of
docs/261/263 it is marked as such. What he actually said:

- "add as many named reviewer configurations as they want and invoke one by name ('review with
  `deep-dive`')" → reqs 1 and 2.
- "invocation by name is at least as short as the ad-hoc spelling" → req 3.
- "'save a reviewer called `deep-dive` = GPT-5.6 at high effort' is a sentence, not a Settings
  excursion" → req 4.
- "convert novelty into assets … the easiest path becomes the habit — so the sustainable path
  must be the easy path" → req 3, and the shaping principle in the preamble.
- "Keep the ad-hoc path as the *discovery on-ramp* (you cannot save a reviewer you have not
  tried) and make **conversion** the mechanism — not prohibition" → reqs 5 and 6.
- "the same (model, effort) combo requested twice triggers an offer to save it as a named
  reviewer (the propose-actions pattern)" → req 6, with the mechanism (propose-actions) left to
  `plan.md` and the trigger to open question 4.
- "the config set … each a full tuple (service, billing mode, model, effort; maybe harness)" →
  req 1, with the harness axis deliberately deferred to open question 2 because docs/261 already
  decided model-first for reviewers.

Reqs 7, 8 and 9 are the agent's, each a restatement of an existing rule the feature must not
lose: docs/263's model-name resolution (7), docs/261 req 3 (8), and docs/261 req 9 (9). Req 7 is
stated because name resolution over a *second* name-space is the one genuinely new failure mode
this feature introduces, and it must fail as legibly as docs/263's does.
