---
issue: planning#349
title: Configurable reviewer — requirements
description: A reviewer the user configures once in ShipIt, that works whichever model is implementing.
---

# 261 — Configurable reviewer: requirements

**These are the things this feature changes. Everything ShipIt already does is a requirement
too, and is not restated here** — existing behaviour must keep working at least as well as it
does today.

This feature exists because inviting a second model to review work is only **half**
configured today. Part of it is a ShipIt setting (the sub-agent defaults, per harness), and
the other part the agent decides for itself: it writes `--agent codex` because a line in
`CLAUDE.md` tells it to. That is product behaviour living in a per-repository markdown file.

Two open questions are outstanding — see below. **No implementation work may start while they
are open.**

## Requirements

1. A user configures the reviewer **in ShipIt's settings, completely**: the service, the
   model, and the reasoning level. Nothing about which reviewer runs is left to the agent to
   decide.

2. The reviewer is **ShipIt's setting**. It applies to every session and every repository
   without depending on any file in the repository being reviewed, so a repository that says
   nothing about reviewing still gets a fully configured reviewer — where today it gets
   whatever `CLAUDE.md` happens to say.

   That is a **default, not a prohibition**. A repository may override it, and ShipIt neither
   prevents that nor tries to detect it: an instruction in a repository that names the
   service, the model and the reasoning level explicitly is simply req 7's explicit path being
   used. What this requirement fixes is where the *default* lives, not who is permitted to
   depart from it. A repository overriding the reviewer must name **every** parameter, because
   naming a role and naming a reviewer are the two different things req 6 separates.

3. A reviewer is selected **the same way every other model is selected** (docs/252 req 3):
   it names a service, a billing mode and a model, and the harness that runs it is
   **derived** from that model rather than chosen — exactly as background work already
   resolves (docs/252 req 9).

4. **Reviewing works whichever model is implementing**, with nothing to keep in sync between
   the cases and no editing between sessions. The user configures **two** reviewers, and
   ShipIt uses whichever of them is **furthest from the implementer**.

   *Furthest* is stated as the goal because it is the goal: a second opinion is worth having
   in proportion to how little it shares with the first.

   **The model family is what ShipIt checks first.** A reviewer from a different family is
   preferred above every other kind of difference, because the family is what carries the
   training a second opinion is trying not to share. A family is **not** a service: a gateway
   can serve another vendor's model, so two different services can offer the same family and
   differ in nothing that matters here. A different harness as well is better still.

   What the install actually has may not allow the ideal — a user may have configured no
   second harness, or only one family — so ShipIt takes the best available difference rather
   than refusing. The rest of the ranking below family is design and belongs in `plan.md`;
   what this requirement fixes is that family is the first axis, and that ShipIt never reviews
   work with the thing that produced it when it has any configured alternative.

5. The reasoning level is **part of the reviewer's configuration**, not a separate decision
   and not left to the harness's own default.

6. An agent asks for a review **by naming the role, never the reviewer**. It supplies no
   service, no model and no harness. Asking for a review and choosing who performs it become
   two different things, and only the first belongs to the agent.

7. **Everything else a spawned agent runs on is named at the call.** Outside a role, a
   caller states the harness, the model — which means the service and the billing mode too,
   since that is what identifies a model (req 3) — and the reasoning level. **No stored
   setting fills in an omission**, and an incomplete call is refused rather than completed
   from somewhere the caller cannot see. The roles are the implicit paths, and they are the
   only implicit paths.

8. **Review works without anyone having configured a reviewer**, on any install that can run
   an agent at all, and it never points at a service the user has no credential for. Both
   reviewers therefore have a **derived** default rather than a named model — the same
   argument docs/252 req 9 made for background work.

   An auto-configured reviewer is **complete**: it resolves to everything req 1 says a
   reviewer is, reasoning level included. A reviewer that derived a model but left the
   reasoning level to whatever the harness does by default would not satisfy req 5, and would
   make "configured in one place" false for the case nobody has touched.

   A reviewer the user has not pinned is **auto-configured**, and stays auto-configured: it
   **re-derives as the install changes**, so adding a second service, or a model from a family
   the install did not have, improves the reviewer without anyone editing it. Auto-configuring
   is not a value written once at first run — that would freeze a one-service install's answer
   in place, and the case this feature exists for (req 4's different family) is exactly the
   one that only becomes possible *later*, when a second service is added.

   **Auto-configured is a state the user can see.** For each reviewer the UI says whether it is
   auto-configured or pinned, and what it currently resolves to — so a reviewer that changed
   because a service was added is legible rather than surprising. A pin always wins: nothing
   re-derives over a choice the user made.

9. ShipIt reports what a review actually ran on, and its usage and cost are attributed to the
   service and billing mode that served it — as any other work is (docs/252 reqs 11 and 16).
   This restates existing behaviour because this feature must not lose it, not because it
   changes.

## Scope

The child-session case is **assumed** out of scope — see the first open question. Nothing is
designed or built for it here.

## Open questions

- **What happens to the per-harness sub-agent defaults people have already set?** Req 7
  removes the stored defaults, and some installs have a deliberately chosen model and
  reasoning level per harness. Three answers, and this is a decision about other people's
  configuration rather than one the agent should make: **(a) migrate** the existing Claude and
  Codex defaults into the two reviewer slots as pins; **(b) discard them**, with a visible
  notice saying what was cleared and where the setting went; **(c) keep reading them for one
  release** as a compatibility path, then discard. Recommendation: **(b)**. Migration looks
  kind but is wrong — those defaults applied to *every* consult, not only reviews, so
  promoting them to reviewer pins asserts an intent the user never expressed, and it would
  silently defeat req 8's auto-configuration on exactly the installs that had configured
  something. Raised by the cross-backend review.

- **Is the child-session case in scope?** The human named "the review case and the child
  session case" as the two paths that get their own support, which the agent read as evidence
  for removing the stored defaults rather than as a request to build a child-session role. A
  child session already inherits its parent's selection, so the agent assumed no work is
  needed. That assumption has not been confirmed, and the *Scope* section above depends on it.
  Recommendation: **confirm out of scope**, and let a child-session role be its own feature if
  it is wanted.

## Resolved questions

- 2026-08-10 — **Cross-backend review of this document and its design** (Codex, under
  CLAUDE.md's rule that the other backend reviews substantive work). Fifteen findings; all
  fifteen were checked against the code and the material ones held. Three changed
  *requirements* and are recorded here — the rest were design defects and are fixed in
  `plan.md`, and two became the open questions above.

  - **Req 7 was mechanism.** "ShipIt keeps **no** stored per-harness defaults" is an internal
    storage decision, not an observable property. Rewritten to state what a caller
    experiences — nothing fills an omission, and an incomplete call is refused — with the
    deletion of the store moved to the design where it belongs. The reviewer also caught that
    req 7 said "the model" while req 3 defines a model as `(service, billing mode, model)`, so
    "explicit" was under-specified in the requirement itself.
  - **An auto-configured reviewer was incomplete.** Req 5 makes the reasoning level part of
    the reviewer; req 8 requires both reviewers to work before anyone pins them; and the
    design derived service, mode, model and harness but *not* reasoning — so an untouched
    reviewer fell back to the harness default, which is the one thing req 5 forbids. Req 8 now
    says an auto-configured reviewer resolves to a complete reviewer.
  - **"Fresh install" claimed more than the product does.** `shipit agent run` is gated by a
    Multi-agent setting that is **off by default** (`credential-store.ts:1150`,
    `enableSubAgents ?? false`, rejected at `sub-agent.ts:209`), and an install with no
    credential at all can run nothing. Req 8 now says "without anyone having configured a
    reviewer, on any install that can run an agent at all", which is what was actually meant.
    Whether reviewing should bypass that gate is a separate product question and is not
    assumed here.

- 2026-08-10 — **Is the derived default a one-time value, or does it keep following the
  install?** **Chosen: it keeps following, and the state is visible.** Raised by the human
  reviewing this document: "We need to think how we auto-configure the best reviewer if the
  user adds a second service or a different model. Probably need notion, visible in the UI
  *auto-configured* for a reviewer." The agent's req 8 had said only that a fresh install
  derives, which a one-time write at first run would satisfy — and that would be worst
  precisely where this feature is aimed, because a single-service install cannot satisfy req
  4's different-family preference at all, and the moment it could (a second service added) is
  the moment a frozen value would stop improving. Req 8 gains the re-derivation and the
  visible auto-configured/pinned state. A pin still wins outright; auto-configuration never
  overrides a choice the user made.

- 2026-08-10 — **May a repository override the reviewer?** **Chosen: yes — it is a default,
  not a prohibition.** The agent's req 2 had said the reviewer is "not a repository's" and
  that a repository "never says *who* reviews". The human: "let's allow the repo to override
  the settings in the UI (in fact, we can't prevent it). In this case the agent needs to
  specify all parameters explicitly." The parenthesis is the decisive part — a requirement
  forbidding something ShipIt cannot detect or enforce is a claim the product cannot keep, and
  writing it down would have made the design assert a guarantee it does not have. Req 2
  rewritten: ShipIt owns the **default**, and an overriding repository uses req 7's explicit
  path, naming every parameter. This adds no mechanism; it removes a false promise.

- 2026-08-10 — **What is the first axis of req 4's distance ranking?** **Chosen: the model
  family.** The agent had left the whole ranking to `plan.md` and drafted it there as
  service-first. The human: "model needs to be checked first, i.e. better pick a model from a
  different family." That is a stronger criterion than service, and the reason is a case
  docs/252 deliberately created: a gateway serves another vendor's models, so OpenRouter and
  Anthropic are two different *services* offering the same *family*, and a service-first
  ranking would call that pair distant when it shares everything that matters. Req 4 now fixes
  family as the first axis and leaves the rest below it to design. Consequence for the design:
  the catalogue has no family notion today, so one has to be authored per model — recorded in
  `plan.md`, not here.

- 2026-08-10 — **What makes ShipIt use the second reviewer rather than the first?** **Chosen:
  neither of the three rules offered — state the goal instead.** The options put were "same
  service", "same exact model" and "same harness", each a collision test against the *first*
  reviewer. The human rejected the framing: "the idea is to use the reviewer that is far away
  from the implementer. Ideally, it's a different model and different harness, but the user
  may not have other harnesses configured." So the selection is not a collision test with a
  fallback, it is a **distance ranking over the configured reviewers**, and it degrades to
  the best available difference rather than to a designated second choice. Req 4 rewritten to
  say that and to leave the ranking to `plan.md` — the human's own note that "the exact logic
  needs to be figured out" is what makes the rule design rather than requirement.

- 2026-08-10 — **Do the per-harness sub-agent defaults survive?** **Chosen: remove them, and
  make every non-role spawn fully explicit.** The recommendation was only to remove them; the
  human went further — "make all the agent parameters explicit in the agent run … not only
  the harness, which I suggest replacing the agent flag, but also the model and the thinking
  level. So everything in the call would be explicit, because for implicit calls, we already
  have, we will have custom support, which is the review case and the child session case."
  That is a cleaner division than the one offered: **roles are the implicit path, and the raw
  call is the explicit one**, with nothing stored in between. Req 7 states it. The consequence
  is that `SubAgentDefaults` is deleted rather than superseded, which is also what empties the
  per-vendor Settings tabs — the audit (`docs/252-custom-models/ui-audit.md`, D16) found them
  to be the only thing those tabs uniquely held.

- 2026-08-10 — **How does an agent ask for a review?** **Chosen: a new `--role reviewer`
  flag.** Taken as offered, against making `--agent` optional (which would reinterpret an
  existing flag's absence, where today an omitted `--agent` is a hard error — so a forgetful
  caller would silently get a review) and against a separate verb (which would duplicate the
  run/result plumbing). Req 6.

- 2026-08-10 — **What does a fresh install do before anyone configures a reviewer?**
  **Chosen: derive both.** Taken as offered. Review works out of the box, and a derived
  default cannot name a service the install has no credential for — the same reasoning
  docs/252 req 9 recorded for background work. Req 8.

- 2026-08-10 — Does a reviewer name a harness, or a model? **Chosen: a model — unify on
  model-first.** The tension was real: docs/252 established that you pick a model and the
  harness is derived, while "have Codex review this" appears to select a harness and let the
  model follow. Three options were put: two shapes each honest about what it selects on;
  unify on harness-first (which would have amended docs/252 req 9); or unify on model-first.
  The human chose model-first, which is why req 3 states the derivation rather than
  introducing a harness axis. The consequence is that "not the same reviewer twice" cannot be
  expressed as a harness rule and is instead expressed by configuring two reviewers and
  ranking them by distance (req 4).

- 2026-08-10 — Is this policy that belongs in `CLAUDE.md`? **Chosen: no — it is ShipIt
  functionality.** The human: "it's not about CLAUDE.md, because CLAUDE.md is about a
  specific repository, whereas we discuss the ShipIt functionality." Req 2. This also rules
  out the cheapest option that had been offered — leaving reviewer choice to repository
  policy and only changing the CLI's default.

## Requirement provenance

The feature exists because of a workflow the human described, and most of its shape is his.
What he actually said:

- "I usually run Claude as the implementer, and ask it to invoke Codex for a second opinion
  on designs and code. The primitive in my head is: invoke a reviewer." → the feature exists
  at all, and req 6's framing that asking for a review is one thing and choosing the reviewer
  is another.
- The reviewer is "only half configured — part sits in settings, and the other part the agent
  picks for itself" → reqs 1 and 6.
- "when Codex is the main implementer, Opus should be the reviewer, with its own default
  settings" → req 4.
- "our reviewer would be Anthropic plus model plus thinking level" → reqs 1 and 5. The
  reasoning level being *part of the reviewer* rather than a separate control is his.
- "for the case where the authoring model is the same … we need kind of default reviewer. So
  the user should be able to configure these two reviewers." → req 4's count of two, both
  fully configured.
- "the idea is to use the reviewer that is far away from the implementer. Ideally, it's a
  different model and different harness, but the user may not have other harnesses
  configured." → req 4's distance goal, replacing the three collision rules the agent had
  offered.
- "it's not about CLAUDE.md, because CLAUDE.md is about a specific repository, whereas we
  discuss the ShipIt functionality" → req 2.
- "Unify on model-first" → req 3, chosen from three options; see the receipt.
- "Remove them and make all the agent parameters explicit in the agent run … everything in
  the call would be explicit, because for implicit calls … we will have custom support, which
  is the review case and the child session case." → req 7, and the *Scope* note. The
  generalization from "remove the defaults" to "roles are the only implicit path" is his.
- "let's allow the repo to override the settings in the UI (in fact, we can't prevent it). In
  this case the agent needs to specify all parameters explicitly." → the rewrite of req 2,
  which the agent had drafted as a prohibition.
- "model needs to be checked first, i.e. better pick a model from a different family" → req 4's
  family-first axis, which the agent had drafted as service-first and had left entirely to the
  design.
- "We need to think how we auto-configure the best reviewer if the user adds a second service
  or a different model. Probably need notion, visible in the UI *auto-configured* for a
  reviewer." → req 8's re-derivation and its visible auto-configured state.

Reqs 8 and 9 are the agent's recommendations, taken as offered; req 9 states an existing
obligation rather than a new one — it is here so that attribution is not quietly lost, and
should be struck if that is not wanted.
