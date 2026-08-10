---
issue: planning#349
title: Configurable reviewer — requirements
description: A reviewer the user configures once in ShipIt, that works whichever model is implementing.
---

# 260 — Configurable reviewer: requirements

**These are the things this feature changes. Everything ShipIt already does is a requirement
too, and is not restated here** — existing behaviour must keep working at least as well as it
does today.

This feature exists because inviting a second model to review work is only **half**
configured today. Part of it is a ShipIt setting (the sub-agent defaults, per harness), and
the other part the agent decides for itself: it writes `--agent codex` because a line in
`CLAUDE.md` tells it to. That is product behaviour living in a per-repository markdown file.

Design: `plan.md` (not written yet — no implementation work may start while an open question
remains below).

## Requirements

1. A user configures the reviewer **in ShipIt's settings, completely**: the service, the
   model, and the reasoning level. Nothing about which reviewer runs is left to the agent to
   decide.

2. The reviewer is **ShipIt's setting, not a repository's**. It applies to every session and
   every repository, and it does not depend on any file in the repository being reviewed.
   A repository may still say *when* to ask for a review; it never says *who* reviews.

3. A reviewer is selected **the same way every other model is selected** (docs/252 req 3):
   it names a service, a billing mode and a model, and the harness that runs it is
   **derived** from that model rather than chosen — exactly as background work already
   resolves (docs/252 req 9).

4. **Reviewing works whichever model is implementing.** A Claude session gets a review from
   something that is not itself, and so does a Codex session, with no setting to keep in sync
   between the two cases and no editing between sessions.

   The user configures **two** reviewers to achieve this: a first choice, and a second one
   used when the first would collide with whatever is implementing. Both are configured the
   same way (req 1), so the second is a reviewer in its own right rather than a degraded
   fallback.

5. The reasoning level is **part of the reviewer's configuration**, not a separate decision
   and not left to the harness's own default.

6. An agent asks for a review **without naming a service, a model or a harness**. Asking for
   a review and choosing who performs it become two different things, and only the first
   belongs to the agent.

7. ShipIt reports what a review actually ran on, and its usage and cost are attributed to the
   service and billing mode that served it — as any other work is (docs/252 reqs 11 and 16).
   This restates existing behaviour because this feature must not lose it, not because it
   changes.

## Open questions

- **What makes ShipIt use the second reviewer rather than the first?** Req 4 says "when the
  first would collide with whatever is implementing", and *collide* is the agent's word, not
  the human's. Three readings, and they behave differently in ordinary use:
  **(a) same service** — any Anthropic-served session is reviewed by the second reviewer;
  **(b) same model** — only an exact model match switches, so Anthropic Sonnet could be
  reviewed by Anthropic Opus; **(c) same harness** — a Claude Code session switches whatever
  model is driving it, which is what `CLAUDE.md`'s existing rule literally says.
  Recommendation: **(a) same service**, because the blind spot a second opinion exists to
  avoid belongs to the model's vendor and training, not to the CLI that spawns it — and (b)
  would let one vendor review itself, which is the case this feature exists to prevent.

- **Do the per-harness sub-agent defaults survive this feature?** They store exactly this
  feature's tuple — `(service, billing mode, model, reasoning effort)` — keyed by *harness*,
  and their only consumer is the sub-agent spawn that a review already goes through
  (`sub-agent.ts:285`). Recommendation: **remove them.** The reviewer settings replace them
  for the reviewing case, and an explicitly named `shipit agent run --agent X` can fall back
  to that harness's first eligible model, which is the path the code already has. Keeping
  both would leave two places that answer "what does a spawned agent run on".

- **How does an agent ask for a review (req 6)?** Options: a new `--role reviewer` flag
  alongside today's `--agent`; making `--agent` optional so an omitted one means "the
  configured reviewer"; or a separate verb. This decides whether a non-review consult
  (`shipit agent run --agent codex` for something that is not a review) keeps working
  unchanged, and it is the difference between adding a concept and widening one.

- **Does the reviewer setting need a default, and what is it?** Nothing was said about the
  unconfigured install. Without a default, review does not work until someone configures it;
  with one, ShipIt has to pick, and docs/252 req 9 argues a **derived** default (whatever the
  install can actually run) rather than a named model. Recommendation: derive both reviewers
  the same way — the first eligible model, and the first eligible model of a *different*
  service — so review works on a fresh install and never points at a service the user has no
  credential for.

## Resolved questions

- 2026-08-10 — Does a reviewer name a harness, or a model? **Chosen: a model — unify on
  model-first.** The tension was real: docs/252 established that you pick a model and the
  harness is derived, while "have Codex review this" appears to select a harness and let the
  model follow. Three options were put: two shapes each honest about what it selects on;
  unify on harness-first (which would have amended docs/252 req 9); or unify on model-first.
  The human chose model-first, which is why req 3 states the derivation rather than
  introducing a harness axis. The consequence is that "not the same reviewer twice" cannot be
  expressed as a harness rule and is instead expressed by configuring two reviewers (req 4) —
  the human's own answer, given in the same breath.

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
  the user should be able to configure these two reviewers." → req 4's second reviewer. The
  count — two, both fully configured — is his, not the agent's.
- "it's not about CLAUDE.md, because CLAUDE.md is about a specific repository, whereas we
  discuss the ShipIt functionality" → req 2.
- "Unify on model-first" → req 3, chosen from three options; see the receipt.
- "I'm not sure if we need per-harness settings. Maybe we need a separate reviewer tab only?"
  → recorded as an **open question** rather than as a requirement, because it was asked
  rather than decided.

Req 7 is the agent's, and states an existing obligation rather than a new one — it is here so
that attribution is not quietly lost, and should be struck if that is not wanted.

The trigger for the second reviewer (the first open question) is **not** settled by anything
the human said; req 4 deliberately states the observable goal and leaves the rule open.
