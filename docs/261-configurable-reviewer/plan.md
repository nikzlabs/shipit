---
issue: planning#349
title: Configurable reviewer — design
description: Two configured reviewers, ranked by distance from the implementer, reached by --role reviewer.
---

# 261 — Configurable reviewer: design

Implements [`requirements.md`](./requirements.md). Requirement numbers below refer to it.

## What this is

Today "get a second opinion" is assembled from two halves that do not know about each other:
a per-harness stored default (`SubAgentDefaults`, keyed by `AgentId`) supplies the model and
reasoning level, and the **agent** supplies the harness by writing `--agent codex`, because
`CLAUDE.md` tells it to. This feature makes the reviewer one configured thing (req 1) that
lives in ShipIt rather than in a repository (req 2), and reduces the agent's part to naming a
role (req 6).

The load-bearing simplification: **roles are the only implicit path.** Everything else a
spawned agent runs on is explicit at the call (req 7). That is what lets `SubAgentDefaults`
be deleted rather than re-keyed, and it is why there is no third place that answers "what
does a spawned agent run on".

## A reviewer is a model, not a harness

Req 3 keeps docs/252's direction: a reviewer names `(serviceId, billingMode, modelId)` plus a
reasoning level, and the harness is **derived**. Most of the machinery already exists for
background work and is reused — but *not* unchanged; see *The reviewer's harness derivation is
its own* below for the part that must differ.

- `harnessForNonTurnSelection(selection, credentials)` (`non-turn-model.ts:144`) — its
  eligibility check and its docs/252 req 13 **retirement-successor** handling are reused
  wholesale, so a reviewer pinned to a retired model keeps working. Its *choice* of harness
  (the first installed one) is what this feature replaces.
- `firstEligibleNonTurnSelection(credentials)` (`:169`) is req 8's derived default in the
  picker's own ordering — first service, first billing mode, first model.

Reasoning level is part of the reviewer (req 5) even though it is a property of the *harness*
(docs/252's 2026-08-08 receipt). That is consistent rather than contradictory: the harness is
known once the model is, so the Settings control offers the derived harness's levels. A level
the harness rejects is the harness's error to report, which is the corollary docs/252 already
recorded.

## Two authored identities, not one

An earlier draft gave `ModelDef` a single `family` field and used it for two different jobs:
proving that a gateway-served `anthropic/claude-opus-5` and a direct `claude-opus-5` are **the
same model**, and expressing that Opus and Sonnet share a **lineage**. Those are different
questions, and one field cannot answer both — Opus and Sonnet are one family and two models,
while the two Opus spellings are one model under two ids. The cross-backend review found this,
and it is what made the ranking below expressible at all.

So two authored fields:

- **`canonicalModelKey`** — identity. Two offerings with the same key *are the same model*,
  whatever their ids or services. It collapses gateway prefixes (`anthropic/claude-opus-5`),
  mode suffixes (`glm-5.2[1m]`) and vendor aliases.
- **`family`** — lineage. The training a model shares with its siblings. Opus and Sonnet share
  one; DeepSeek and GLM do not.

Neither is derivable. Not from the service — docs/252 deliberately lists one model under a
vendor and under a gateway, so `anthropic` and `openrouter` are two services offering one
model. Not from the id — `anthropic/claude-opus-5` and `claude-opus-5` differ as strings and
are identical as models, while `glm-5.2` and `glm-5.2[1m]` differ as strings and are one model
in two modes. Authored fields are the only honest source, on a catalogue docs/252 req 6 keeps
deliberately small.

**The invariant has to be written against the case that motivates the field.** An earlier
checklist item said "one model id offered by two services declares the same family in both",
which cannot catch anything: the motivating pair has *different* ids. The real invariants are
that every offering declares both fields, that every member of a `canonicalModelKey` group
agrees on its `family`, and that the alias groups are declared once and referenced rather than
retyped per offering — a free-form string copied into every row makes a typo compile, pass,
and cause ShipIt to call a same-model review independent.

## Picking between the two: the distance ranking

Req 4 fixes the first axis — the model **family** — and leaves the rest here. It is an ordered
list of predicates, not a weighted score, because it has to be explainable in one line to
whoever reads the Settings screen.

Given the implementer's resolved `(harness, service, family, canonicalModelKey)` and the
configured reviewers in user order, take the first reviewer satisfying the highest-priority
predicate that any of them satisfies:

1. different family **and** different harness — the ideal
2. different family
3. different canonical model **and** different harness
4. different canonical model
5. same canonical model, different harness
6. otherwise the first configured reviewer

**Tiers 3–5 are where the first draft was wrong, and the bug was not subtle.** That draft
ranked "different harness" above "different model", so with an implementer on model M / family
F / harness H1, a reviewer offering *the same model M* on H2 beat a reviewer offering a
*different* model N on H1. Same weights, same training, same answers — reviewing itself
through a different CLI. That contradicts req 4's promise never to use "the thing that
produced it when it has any configured alternative", and it contradicts the human's
"model needs to be checked first". Canonical model now outranks harness throughout, and the
same-model case is demoted to tier 5, reachable only when nothing else is configured.

Family outranks even a different model because it carries the training; a Claude Code session
driving DeepSeek shares nothing with Anthropic but the process it runs in. Tiers 3–5 exist for
the install that has only one family, where req 4 says to take the best available difference
rather than refuse.

**Service does not appear in the ranking at all.** It was the draft's second step, and family
plus canonical model replace it: two services offering one model are not distant. Service
still decides the credential and the price — it just says nothing about independence.

**The ranking is computed against the implementer's *resolved* selection**, not the session's
stored pin: a session that failed over, or was remapped by a retirement, must be compared
against what it is actually running (docs/252 req 11).

## The reviewer's harness derivation is its own

Req 3 keeps the harness derived, and the draft reused `harnessForNonTurnSelection` unchanged.
The cross-backend review found why that is wrong here, and it is a good example of CLAUDE.md's
"verify an inherited guarantee at the source": that function returns the **first installed
harness** that can run a selection, and docs/252 accepts that as *arbitrary* precisely because
background work is a session title, where the harness does not matter.

Here the harness is a ranking axis. If a reviewer's model runs on both installed harnesses,
catalogue order can hand it the implementer's own harness and drop the ranking a tier for no
reason. So reviewer harness derivation takes the same eligibility, retirement-successor and
routing machinery but applies its own preference: **among the installed harnesses that can run
the selection, prefer one that is not the implementer's.** Still derived, never chosen, so
docs/252 req 9 is untouched.

## Eligible is not runnable

A reviewer whose credential or harness has gone away is skipped. That is necessary and not
sufficient: **a configured, eligible subscription whose accounts are all quota-exhausted is
still eligible**, and route selection returns `all_exhausted` (`service-routing.ts:258`). The
draft would have ranked that reviewer first and then failed, with a perfectly good second
reviewer sitting unused.

So the ranking considers only targets that **have a usable route at invocation time**, and a
pre-spawn route failure falls through to the next reviewer rather than ending the review. Only
when no reviewer has a route does the review stop and say so — the same shape as docs/252 req
9's dismissible notice, not a silent no-op.

## Auto-configuration (req 8)

Each reviewer slot holds **either** a user pin **or** nothing, and nothing means
*auto-configured* — not "a value ShipIt wrote once". The distinction is the requirement: the
derived answer is computed **at read time**, from the install as it currently stands, exactly
as `resolveNonTurnModel` already does for background work (`non-turn-model.ts:194`, whose
docstring records the same "resolved at read time and NOT written back" decision and the same
reason).

That is what makes adding a second service improve the reviewer with no user action. It also
means there is no migration, no staleness and no write path to get wrong: an empty slot is
empty forever until the user pins something.

- reviewer 1 — `firstEligibleNonTurnSelection`, unchanged.
- reviewer 2 — **the same distance ranking, run against reviewer 1** rather than a
  `skipFamily` filter. The draft's filter refused to derive anything at all on a one-family
  install, which is precisely where req 4 says to take the best available lesser difference,
  and it left one of req 8's two reviewers unresolved on exactly the installs that need the
  fallback most. One ranking function derives both slots and degrades correctly through model
  and harness, so there is one implementation of "distant" rather than two that can disagree.

**Reasoning is part of what is derived, not left out of it.** Req 5 makes the level part of the
reviewer and req 8 makes an unpinned reviewer complete, so the resolver returns an effort too:
ShipIt authors a default level per harness, and the derived reviewer carries it. The draft
derived service, mode, model and harness and stopped, which quietly fell back to the harness's
own default — the one thing req 5 forbids.

**Pinning is atomic.** Editing *any* field of an auto-configured slot pins the whole resolved
tuple — model, service, mode and effort — and a *Reset to auto* action returns the slot to
derivation. Half-pinned slots (a pinned effort over a derived model) are not expressible,
because the alternative is a slot that silently re-derives half of itself when a service is
added.

**Resolved once, at spawn admission.** "Read time" needs a boundary or the reviewer can change
under a running invocation: the implementer's own selection is read from the turn's captured
resolution rather than the mutable session row, and the reviewer is resolved **and routed**
once when the spawn is admitted. That immutable target is then what retries, attribution and
the transcript card all use. Recomputing during a retry is how a review ends up attributed to a
model that did not run it.

The settings payload carries the resolution, and it must be **re-broadcast when a credential,
the catalogue or harness availability changes** — otherwise an open Reviewer tab keeps showing
the answer from before the service was added, which is the one thing req 8's visible state
exists to prevent.

**Settings shows the state, per slot**: *Auto-configured* or *Pinned*, and what it currently
resolves to. `BackgroundWorkSection` already renders exactly this — a derived default as a
labelled option carrying what it resolves to, rather than a blank — and its
`nonTurnModelResolved` wire member is the precedent to copy, including its rule that the
server sends the resolution rather than the client re-deriving it (a second implementation of
the rule is how the two drift).

## The CLI (reqs 6, 7)

`shipit agent run` gains `--role reviewer` and loses its stored defaults. **The explicit path
is more work than it looks, because it barely exists today** — the cross-backend review
checked, and the checks reproduce:

- the CLI parses `--agent`, `--prompt-file`, `--model` and `--json`, and **no effort flag at
  all** (`shipit-agent.ts:60-66`);
- the shim never puts the model in the request body, and the orchestrator's spawn route
  declares `Body: { agentId?, prompt?, depth? }` (`api-routes-agent.ts:122`) — so **`--model`
  is parsed and silently dropped today**. That is a pre-existing bug this feature must fix
  rather than inherit;
- nothing anywhere carries a service or a billing mode, which req 3 makes part of a model's
  identity — `anthropic/claude-opus-5` is offered by both OpenRouter and Vercel, and `--model`
  alone cannot say which credential pays.

So the explicit shape is defined end to end, and every part is mandatory outside a role:
`--agent`, `--service`, `--billing-mode`, `--model`, `--effort`. Threaded through the CLI
parser, the worker relay body, the HTTP route schema, `RunSubAgentInput`, validation, the
spawn and attribution. An omission is an **error**, not a silent completion — which is req 7
restated, and is why `fallbackModel` cannot survive on this path.

- `--role reviewer` — mutually exclusive with all five. A call naming a role *and* a reviewer
  is asking two different questions, and req 6 separates them.
- The spawn's read of `getAgentSubAgentDefaults` (`sub-agent.ts:285`) is replaced by the role
  resolution or by the explicit arguments, and the store is deleted.

**Every product-owned caller has to move with it.** The draft named only `CLAUDE.md`, which
was wrong — ShipIt itself authors and generates these commands in at least four more places,
and after req 7 each would either break for missing arguments or quietly bypass the reviewer:

- `client/utils/compose-review-body.ts:117` — the UI **generates** a review instruction with
  an explicit `--agent <reviewerAgentId>`. This is the most important one: it is ShipIt
  choosing the reviewer in the product's own words, which is the very thing this feature
  exists to stop.
- `orchestrator/agents/claude/system-prompt.md:17` and `agents/codex/system-prompt.md:18`
- `orchestrator/prompts/spec-discipline.md:8` — "prefer a backend other than your own", which
  becomes the role's job rather than the agent's judgement.

Each is classified as *role-based review* (rewrite to `--role reviewer`) or *explicit general
spawn* (given the full argument set), with a test per product-owned command.

`CLAUDE.md`'s "review with the other backend" line loses its harness instruction: it keeps
saying *when* to ask for a review, and stops naming the backend (req 2).

**A repository may still override the reviewer, and nothing here tries to stop it** (req 2).
The explicit path is the override: a repository instruction that names `--agent`, `--model`
and the effort is an ordinary explicit call and is indistinguishable from any other. This is
why req 2 is written as a default rather than a rule — ShipIt cannot detect the difference
between an agent following repository policy and an agent making its own choice, so claiming
to forbid it would be asserting a guarantee the product does not have.

## Settings

The audit (`../252-custom-models/ui-audit.md`, D16) found the per-vendor Claude/Codex tabs
uniquely held exactly one thing: `SubAgentDefaultsSection`. Req 7 deletes it, so:

- **`SubAgentDefaultsSection` is removed**, with `SubAgentDefaults` and its store, wire and
  route members (`credential-store.ts:1208`, `services/settings.ts:457`, the bootstrap and
  WS shapes).
- **`ClaudeTab` and `CodexTab` are removed**, and with them the `agent-claude` / `agent-codex`
  tabs and the "Agent" nav group (`Settings.tsx:23`, `:144-165`).
- **A "Reviewer" tab** holds the two reviewers, each a model picker grouped by
  `(service, billing mode)` plus a reasoning select, and each labelled **Auto-configured** or
  **Pinned** with what it currently resolves to (req 8) — the same control shape as
  `BackgroundWorkSection`, which is the closest existing precedent and already renders a
  derived default as a labelled option rather than a blank.

**Making Services the first and default tab is deliberately NOT here.** It is the audit's D1
and belongs to docs/252, which is where the human asked for it; no numbered requirement in
this document asks for it, and importing it would make this design a second source of
requirements. Removing an emptied section is a consequence of req 7; reordering navigation is
separate work that happens to touch the same file.

One consequence worth stating because it looks like a regression and is not: the API-key
panel on the vendor tabs disappears with them. It is not a loss — it writes through to the
same `(anthropic, key)` / `(openai, key)` credential route the Services add-flow writes
(`services/settings.ts:664`, `:634`), so the credential remains reachable, as a card.

## Phases

| # | Phase | Reqs | Done when |
|---|---|---|---|
| 0 | `canonicalModelKey` + `family` authored per offering, from shared declarations rather than retyped strings | 4 | Every offering declares both; every canonical group agrees on its family; alias groups are referenced, not copied |
| 1 | Storage + resolver: the two reviewer slots, read-time auto-configuration, the distance ranking | 1, 3, 4, 5, 8 | Ranking and derivation are unit-tested against a fabricated catalogue; nothing calls them yet |
| 2 | `--role reviewer`, and the fully explicit `agent run` end to end | 6, 7 | A review spawns on the ranked reviewer; an incomplete explicit call is refused; `--model` reaches the spawn instead of being dropped; `SubAgentDefaults` deleted |
| 3 | Settings: the Reviewer tab, and the emptied vendor tabs deleted | 1, 5, 8 | Both slots configurable, each labelled Auto-configured or Pinned with what it resolves to, refreshed when a credential changes |
| 4 | Attribution: the resolved reviewer persisted on the consult card and rendered | 9 | The card says model, service/mode, harness and effort — not just "Consulted Claude" |
| 5 | Every product-owned caller migrated; `CLAUDE.md` and `shipit-docs` updated | 2, 6 | No authored or generated command names a backend for a review |

**Phase 4 is not "confirm nothing changed".** The draft said attribution was unchanged, and
the review found that the persisted consult card carries only `subAgentId`, duration and cost
(`shared/types/domain-types/chat.ts:51`) — it cannot say which service, model or effort ran.
"Consulted Claude" is actively misleading once Claude Code can drive a non-Anthropic model, so
req 9 needs the captured target persisted on the card, under the transcript-persistence rules
in CLAUDE.md (a typed field, a column and migration, `CARD_MESSAGE_FIELDS`, rehydration, and a
history round-trip test).

The audit's Services work — one card component (D2) and Services-first (D1) — is docs/252's
and is deliberately **not** in this table. It touches `ServicesPanel.tsx` /
`ProviderAccountsCard.tsx`; nothing here does, so the two can run in parallel without
conflicting.
