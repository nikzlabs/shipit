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

The load-bearing simplification: **nothing stored fills in a one-shot spawn's blanks.** A
`shipit agent run` either names a role, and is resolved from the reviewer settings, or names
everything itself (req 7). That is what lets `SubAgentDefaults` be deleted rather than
re-keyed.

There are exactly three ways an agent is started, and each answers "what does it run on"
differently. Writing them down together is what stopped an earlier draft of req 7 from
accidentally outlawing the third:

| Path | What it runs on |
|---|---|
| A **role** (`--role reviewer`) | Resolved from ShipIt's reviewer settings — reqs 1–6, 8 |
| A **one-shot run** (`shipit agent run`) | Named in full at the call; an omission is refused — req 7 |
| A **child session** (`shipit session create`) | Inherited from the parent, with partial override — req 10, unchanged by this feature |

The child-session rule is deliberately the opposite of the one-shot rule, and that is
coherent rather than inconsistent: a child session has a parent to inherit from, and a
one-shot run has nothing but its own arguments.

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

**Phase 0 has landed.** `shared/catalogue/model-identity.ts` is the declaration; `ModelDef`
carries the two fields and every row in `services.ts` supplies them by **spreading** a
declaration (`...MODEL_IDENTITIES.opus5`) rather than typing two strings. The spread is what
turns "declared once and referenced" from a convention into a property of the source: a
mismatched pair is unwritable, not merely caught. Both fields are additionally typed as literal
unions derived from the table, so a typo is a compile error, and `catalogue.test.ts` asserts that
every pair reaching a row is one the table carries — the check that catches a row which typed
the fields by hand anyway.

Two authoring decisions the design left open:

- **Families are vendor-scoped** (`claude`, `gpt`, `deepseek`, `glm`), not generation-scoped.
  Req 4 wants the axis carrying shared training, and Haiku 4.5 sits beside Opus 5 in the
  catalogue — a generation-scoped family would have called that pair distant on a difference that
  changes nothing.
- **`RetiredModel` carries no identity.** The ranking is computed against *resolved* selections
  and a retired pin resolves through its successor before anything asks who it is, so a retired
  row has no identity because nothing ever runs on one.

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

**Phase 1 has landed.** `orchestrator/reviewer-model.ts` holds the ranking
(`reviewerDistanceTier`), the Settings view (`resolveReviewerSlots`) and the review-time choice
(`selectReviewer`); `CredentialStore.getReviewerPin` / `setReviewerPin` hold the two slots.
Nothing calls any of it yet, which is the phase boundary this table sets.

Five things worth recording, three of which sharpen the design rather than merely implement it:

- **Slot derivation is implementer-INDEPENDENT; only the harness bends.** A slot is a *setting*,
  so it must have one answer whether or not a session is in front of the user — otherwise "what
  it currently resolves to" would mean something different on every screen. So the derived
  *model* for each slot ignores the implementer, and the "prefer a harness that is not the
  implementer's" preference is applied at review time, in `selectReviewer`. The design did not
  separate the two, and conflating them would have made req 8's visible state ill-defined.
- **The route check applies to derivation too**, not only to ranking. `plan.md` said reviewer 1 is
  `firstEligibleNonTurnSelection` "unchanged"; it is that ordering narrowed to candidates that
  also resolve a credential route. An auto-configured reviewer with a spent subscription is one
  the review would fall through anyway, so naming it would only make Settings promise something
  that never runs. This is a stated departure, not an oversight.
- **The harness preference is a preference, not a filter** — a model only the implementer's own
  harness can run still resolves. `harnessesForSelection` (extracted from
  `harnessForNonTurnSelection`, so eligibility and retirement-successor handling have ONE
  implementation) returns every eligible harness in preference order, and the resolver walks it
  until one routes. Trying only the first would drop a reviewer whose *other* harness
  authenticates perfectly well.
- **The tie rule is the ranking's sixth rung applied at every rung.** "Otherwise the first
  configured reviewer" is implemented as a strictly-lower comparison, so equal distance always
  keeps the earlier slot rather than only doing so when everything is tier 6.
- **`selectReviewer` returns a frozen target**, which is the half of "resolved once, at spawn
  admission" that phase 1 can deliver. The call site that captures it when a spawn is admitted is
  phase 2's; what phase 1 guarantees is that the value cannot be mutated once resolved.

**What the cross-backend review changed.** Codex reviewed phases 0 and 1 under CLAUDE.md's rule
and returned five findings; all five held on checking and all five are fixed. Two are worth
reading as a group, because both are the same mistake: **a check that could not fail.**

- **The catalogue invariants caught nothing that mattered.** A row can spread the *wrong existing*
  declaration — `MODEL_IDENTITIES.gpt56terra` on the GPT-5.6 Sol row — and every generic
  consistency check still passes, because the pair is valid and agrees with itself. ShipIt would
  then treat Sol and Terra as one model and refuse to let either review the other's work. Fixed by
  tying each row's **id** to its key: `normalizeModelIdForIdentity` drops a gateway's `provider/`
  prefix and Claude Code's `[1m]` suffix (both mechanical restatements of one model), and
  `MODEL_ID_ALIASES` is the single escape — today just Anthropic's `haiku`. An alias entry is
  therefore the one place a human confirms "these really are the same model". A second invariant
  catches the same error from the other side: no billing mode may offer one canonical model twice.
- **The harness preference had no test that could fail.** The only coverage asserted that
  `avoidHarnessId` produced the same list for a model one harness can run — which an
  implementation ignoring the option entirely would also pass. The ordering is now
  `harnessesPreferring`, exported and tested directly, because it cannot be reached through the
  shipped rows.

Three more, each real:

- **The "immutable" target was shallow-frozen and its type was mutable**, so `selection` and
  `route` could still be changed and TypeScript permitted top-level assignment. `ReviewerTarget`
  is `readonly` throughout and the nested objects are frozen **copies**, not references into the
  resolver's own inputs.
- **The tier claimed a family difference ShipIt had not established.** An implementer whose model
  cannot be identified makes the model axes undecidable, and the ranking correctly collapses onto
  the harness axis — but it reported that as tier 1 ("different family"), which a consumer could
  render as an independence nobody checked. `ReviewerSelection` now carries `tierBasis`, so the
  ordering is unchanged and the number can no longer be over-read.
- **`credentialSecretForRoute` did not honour its own contract** for an account-delivered route.
  Unreachable today, because `serviceRoutingForSelection` returns nothing for one — but an
  extracted helper that relies on every caller having checked first is how the next caller gets it
  wrong.

**One property is deliberately untested end to end, and it should not be mistaken for covered.**
No shipped model runs on both harnesses — Claude's family speaks only Anthropic-Messages and
GPT's only Responses — so tiers 3 and 5 are unreachable through the real catalogue, and the
avoid-the-implementer's-harness preference has nothing to prefer between. The ranking's rungs are
therefore pinned as a pure function, and what *is* asserted end to end is the property whose
failure would break the product: that the preference does not refuse a model only one harness can
run. One gateway row gaining a style makes the rest reachable.

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

**Phase 2 has landed.** `services/sub-agent-target.ts` is the whole of "what does this spawn run
on": `parseSubAgentSpawnTarget` reads the request body into a two-shape union (`role` |
`explicit`) and refuses everything in between, and `resolveSubAgentSpawnTarget` turns that into
the harness, model and effort — resolving *and* routing a role through `selectReviewer`.
`runSubAgent` captures it once, before the registry gates, and every step after it reads that one
value. `SubAgentDefaults` is gone: the store, its load-time migration, the settings payload and
patch, the bootstrap field, the WS shape, the client store members and
`SubAgentDefaultsSection` (orphaned when the Services-card session deleted the vendor tabs).

Five things worth recording:

- **The refusal is the server's, not the shim's.** Both check, but only one can be trusted: a
  caller that skips the shim, or a stale shim, must not get an incomplete call quietly completed.
  The shim's copy buys the *message* — the agent learns which flag it forgot without a round
  trip — which is why the two checks are deliberately not shared code.
- **The target is resolved BEFORE the callee's registry gates and AFTER every caller gate.**
  Those registry gates need a harness id and a role's harness is *derived*, so resolution has to
  precede them; it is safe because the ranking only ever returns an installed, credentialed,
  routable harness. Everything about the caller — session, pin, depth, runner, budget — precedes
  resolution instead, because none of it needs a harness and all of it should be reported as
  itself: a recursive call is refused for recursion, not for an unresolvable reviewer.
- **The implementer is the resident process's spawn stamp, not the session row.** The row is
  mutable under a running turn (`set_model`), and ranking against it produces exactly the outcome
  req 4 forbids: a Claude harness producing work with DeepSeek, the user switching the picker to
  Opus, and the review handed back to DeepSeek as though it were the distant one.
  `parseSpawnIdentity` reads `runner.appliedSpawnIdentity`, which moves only when a process is
  spawned — that is, only when what is running changes. The row remains the fallback where there
  is no resident process to ask.
- **A role arrives already routed, and the spawn must not re-ask.** `selectReviewer` ranks only
  reviewers with a usable route, so re-running `selectRouteForSelection` would answer a settled
  question and could answer it differently. The explicit path still resolves its own route where
  it always did, after the cap gate and inside the account-failover loop.
- **The refusal is repeated at the execution boundary.** `SubAgentSpawnRequest.model` is
  required and the worker's `/agent/spawn` refuses a spawn that names none. The orchestrator's
  edge is where an incomplete *call* is refused, but the worker is where a missing model would
  actually be *filled* — the CLI picks its own — so a propagation slip between the two now fails
  loudly instead of quietly reinstating the default this phase deleted.
- **The cap is checked before the target is resolved and spent after it is validated.** Every
  gate about the caller — session, depth, budget — precedes resolution, so a capped or recursive
  call says so rather than first ranking a reviewer it will never spawn; and a refused call does
  not consume one of the turn's three slots.
- **`--effort` is validated against the named harness's own levels rather than passed through.**
  docs/217's rule was that an unrecognized level means "pass no flag", which under req 7 would be
  a value silently *replaced* — the same failure as a value silently supplied. It is refused
  instead. Same for a triple the catalogue does not carry, and for a model the named harness has
  no credential for (`assertHarnessCanRunSelection`, checked against the registry's eligible set,
  skipped when that set is empty because empty means "no credential source wired").
- **This leaves ShipIt's own callers broken until phase 5, on purpose.**
  `compose-review-body.ts` and the two harness system prompts still generate `--agent codex`,
  which is now an incomplete explicit call and is refused. That is the phase boundary the table
  below draws, not an oversight — and it is why phase 5 is not optional cleanup.

**The stored defaults are dropped, not migrated, and there is no notice.** Precisely: the
`agentSubAgentDefaults` key is left where it is in the credentials file and is never read again
— every getter, the load-time migration and the only consumer are gone, so nothing can fill a
blank from it — and no pass rewrites the file to remove it, exactly as the store treats any
other key it does not recognize. What the user experiences is the decision: their configured
sub-agent default no longer does anything, and they reconfigure the reviewer instead. That
is a deliberate decision recorded in `requirements.md`, and its whole justification is that the
install population is currently one person — so it is the decision to revisit if that changes
before this ships, not a general principle about how ShipIt treats settings.

`shipit session create` is untouched. It keeps `--agent` and `--model` (`shipit-session.ts:99`)
and keeps inheriting the rest from the parent (req 10). Worth noting for whoever reads this
next: it has **no reasoning flag**, so the "partial override" it offers covers two of the three
parameters. Out of scope here; recorded so it is not mistaken for complete.

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

**Phase 5 has landed.** Every caller above emits `--role reviewer`; `CLAUDE.md` and the
agent-facing pages (`shipit-docs/agent.md`, `spec-discipline.md`, `sandbox-session.md`) document
the two shapes. All five callers turned out to be *role-based review* — none needed the explicit
argument set, which is the expected outcome: the explicit path exists for a caller that was
**handed** the five values, and ShipIt's own callers never are.

Four things worth recording:

- **The client stopped choosing the reviewer twice, not once.** Rewriting the generated command
  was the obvious half. `resolveReviewer` also asked the agent registry "is a *different*
  backend installed and auth-configured?", and that is the same choice one step earlier — it
  would have sent a review to a same-model `Task` on an install whose reviewer setting names a
  perfectly distant *model on the same harness*, which is a case the ranking exists to find. The
  registry is no longer consulted; what remains is the availability gate that genuinely belongs
  to the caller (Multi-agent sessions off ⇒ `shipit agent run` is refused outright ⇒ compose the
  `Task` fallback).
- **A user naming a backend is now answered with the role, deliberately.** "Review this with
  Codex" cannot become an explicit call: the agent inside a container has no way to discover a
  service, a billing mode or a valid effort level, so filling the five in would mean *guessing*
  — and req 7 makes a guessed value indistinguishable from a supplied one. The prompts say to
  use the role and tell the user which reviewer ran and where to change it, which is also the
  only answer that keeps §1 true (the setting is in ShipIt, not in the turn).
- **The test asserts a command shape, not prose.** Anchoring on "no `shipit agent run --agent
  VALUE` that does not also name the other four" catches the regression this phase exists to
  prevent, while leaving `agent.md` free to document the explicit path in full — which req 2
  needs it to, since the repository override is that path. Anchoring on the *absence* of
  `--agent` would have made the override undocumentable.
- **One doc sentence had to be reworded rather than exempted.** `agent.md` illustrated the
  child-session contrast by writing the refused command out (`shipit agent run --agent codex`
  "is not"), which the check flagged — correctly, since a scanner cannot tell a counter-example
  from a regression. It is phrased without the literal command instead, because a test that
  special-cases counter-examples is one a real regression can defeat by looking like one.

**What the cross-backend review changed.** Codex reviewed phase 5 under CLAUDE.md's rule and
returned eight findings; all eight held and all eight are fixed. The two that mattered were both
the same mistake — **prose that quietly re-decided a requirement**:

- **"This is the path for every review" deleted req 2's override.** The draft split the two
  shapes on *what the run is* (a review ⇒ role; anything else ⇒ explicit), which reads as
  forbidding the thing req 2 explicitly permits: a repository that names all five is choosing
  its own reviewer, and that review *is* an explicit call. The split is now on *what the caller
  was given* — no complete target ⇒ role, a complete target ⇒ explicit — which is the honest
  statement and keeps the override describable. It also puts the real prohibition where it
  belongs: not "don't use explicit for reviews" but **"don't guess values to fill the shape
  out"**, since a guessed parameter and a stored one are indistinguishable to the caller.
- **Two live instructions still sent reviews to a `Task` subagent.** Claude's prompt listed
  "have a separate agent review/check this" among the `Task` cases and used a *review* as its
  worked delegation example — so the same prompt that says every review goes to the role also
  demonstrated one that does not. Both fixed; the example is now a non-review search task. This
  is the finding a command-shape scanner cannot produce, because the regression is an
  instruction that names no command at all.

Four smaller ones, each real: the ranking shorthand said "family first, harness after that" and
skipped the canonical-model tier that sits between them (`reviewerDistanceTier`'s tiers 3–4),
repeated in four files; `plan.md` described the repository override with three of the five
mandatory flags, which is a *refused* call; the guard did not scan `CLAUDE.md`, so this repo's
own review rule could revert silently; and the explicit-shape assertion checked that each flag
appeared *somewhere on the page* rather than together in one command, which a page that never
shows a complete example would still pass. The guard now fails on all five scanned surfaces
when a caller reverts — verified by reverting them and watching it go red, because an
assertion nobody has seen fail is a claim, not a check.

One claim also had to be **withdrawn rather than reworded**: the drafted prose said the consult
card names the reviewer ShipIt picked. It does not yet — the persisted card carries only
`subAgentId` (`chat.ts:51`) and renders the harness name. That is phase 4's work, so the pages
now say only that the card carries the output, attributed to the agent that ran it. Documenting
a sibling phase's not-yet-shipped behaviour is the same error as inheriting an unverified
guarantee, one phase boundary over.

**A repository may still override the reviewer, and nothing here tries to stop it** (req 2).
The explicit path is the override: a repository instruction that names all five — `--agent`,
`--service`, `--billing-mode`, `--model` and `--effort` — is an ordinary explicit call and is
indistinguishable from any other. Naming fewer is not a lesser override but a **refused** call,
which is why the agent-facing prose says to fall back to the role rather than guess the rest. This is
why req 2 is written as a default rather than a rule — ShipIt cannot detect the difference
between an agent following repository policy and an agent making its own choice, so claiming
to forbid it would be asserting a guarantee the product does not have.

## Settings

The audit (`../252-custom-models/ui-audit.md`, D16) found the per-vendor Claude/Codex tabs
uniquely held exactly one thing: `SubAgentDefaultsSection`. Req 7 deletes it, so:

- **`SubAgentDefaultsSection` is removed**, with `SubAgentDefaults` and its store, wire and
  route members. **Done in phase 2**, with the store rather than with the tab: the
  Services-card session had already deleted the two tabs, so the component was dead code
  rendering a setting the server still read.
- **`ClaudeTab` and `CodexTab` are removed**, and with them the `agent-claude` / `agent-codex`
  tabs and the "Agent" nav group. **Done** — by the Services-card session, ahead of this phase.
- **A "Reviewer" tab** holds the two reviewers, each a model picker grouped by
  `(service, billing mode)` plus a reasoning select, and each labelled **Auto-configured** or
  **Pinned** with what it currently resolves to (req 8) — the same control shape as
  `BackgroundWorkSection`, which is the closest existing precedent and already renders a
  derived default as a labelled option rather than a blank.

**Phase 3 has landed.** `services/reviewer-settings.ts` projects phase 1's resolver into the wire
shape (`buildReviewerSettings`) and validates an edit back into a stored pin
(`resolveReviewerPinPatch`); `client/components/Settings/tabs/ReviewerTab.tsx` renders the two
slots. The wire types live in `shared/types/agent-types.ts` beside `ReviewerPin`, not in the
orchestrator's service types, because the browser renders them verbatim.

Five things worth recording, three of which are decisions the design left open:

- **The re-broadcast rides `agent_list`, and that is the whole reason it works.** The design said
  the payload "must be re-broadcast when a credential, the catalogue or harness availability
  changes" without naming a carrier, and the obvious one — a new `reviewer_settings` event — has
  the failure the requirement is about: it needs a call at every credential-mutation site, and the
  site that forgets is the one that made the reviewer stale. `agent_list` is already that funnel,
  built by docs/257 so no producer can hand-roll the payload, and it fires on the changes req 8
  names. So `buildAgentListPayload` carries `reviewers`, and the resolution follows a credential
  automatically. Verified live: removing a service moved slot 2 from DeepSeek back to Sonnet with
  the tab open and untouched.

  **What that does NOT cover, stated precisely, because "never stale" is a stronger claim than
  the code makes.** The resolution also depends on a route being *usable*
  (`reviewer-model.ts`'s route check), and route usability moves on transitions `agent_list` does
  not fire for: a quota-exhaustion stamp (`bootstrap-managers.ts`, `sub-agent.ts`), an exhaustion
  deadline **expiring** — which has no event at all, being a timestamp rather than a write — and
  the `authenticating` window between a login starting and completing. So an open tab can name a
  reviewer that a review would fall through. Cross-backend review found this and it is a real
  limit, deliberately not closed here: exhaustion is transient and self-healing, the ranking
  already falls through to the other reviewer rather than failing (*Eligible is not runnable*
  above), a completed login does fire `agent_list`, and an expiring deadline cannot be pushed
  without polling. The claim this phase makes is the one req 8 asks for — **an auto-configured
  reviewer visibly re-derives as the install changes** — not that every transient routing state is
  pushed within the frame.
- **`buildAgentListPayload` therefore needs the provider account manager, as a REQUIRED
  parameter.** Same `| undefined` shape docs/257 gave the credential store, and for a sharper
  reason: without the manager the resolver cannot see an account-delivered route, so every
  subscription-served reviewer reports as *unavailable*. That is not a missing field but a
  confident wrong answer, pushed to every open tab, by the very broadcast that fires when a
  subscription is connected. `can-run-turns.test.ts`'s existing scan gained a matching
  `carriesAccountManager` check, since the compiler only forces *an* argument.
- **A pin edit may omit the reasoning level, and that is not a hole in req 7.** Req 7 governs the
  one-shot *spawn*; this is the settings API. Omitting the level means "the model changed" — the
  new model may resolve on a different harness with a different level set, and deriving that in
  the browser is precisely the client-side re-derivation req 8 rules out. The server completes the
  tuple from the harness *it* derives and returns the complete pin, so the stored pin is atomic
  either way and nothing is filled in where the caller cannot see it. A level the derived harness
  does *not* declare is refused rather than replaced, which is the same call phase 2 made for
  `--effort`.
- **Slot derivation for the Settings screen is implementer-independent, so the tab needs no
  session.** That is phase 1's decision and this is what it buys: the tab is reachable with no
  session open and still says one true thing per slot.
- **Nothing in the tab is optimistic.** `BackgroundWorkSection` pins optimistically and lets the
  response correct the derived half; that cannot work here, because slot 2 is ranked *against*
  slot 1 and pinning one slot legitimately re-derives the other. Verified live: pinning reviewer 1
  to DeepSeek moved reviewer 2 from DeepSeek to Anthropic in the same response.

  That every response replaces **both** slots is also what makes ordering matter, which the first
  cut got wrong twice and cross-backend review caught: a slow response landing after a fast one
  overwrote the newer snapshot (fixed with a write counter — only the newest response is applied),
  and a single in-flight slot id re-enabled the other control mid-flight (fixed with a set). A
  *failed* write is treated as **ambiguous** rather than as "nothing happened", since the
  connection can drop after the server committed: the tab re-reads rather than keeping a guess.

**One thing the dogfood pass could not exercise**, and it should not be read as covered: no
shipped model runs on both harnesses, so every slot in the two-service install derived onto Claude
Code and the "prefer a harness that is not the implementer's" preference had nothing to prefer
between. That is phase 1's already-recorded gap, unchanged here — the tab renders whatever harness
the server names, and the test fixture is where the two-harness case is pinned.

**And one latent bug the same gap hides, found by cross-backend review and deliberately NOT fixed
here.** A pin's effort is validated against the *implementer-independent* harness
(`reviewer-settings.ts`, which is the only honest choice for a setting — see above), while
`selectReviewer` may resolve the review onto a **different** harness and copies the pinned effort
across without revalidating (`reviewer-model.ts`'s `buildTarget`). A future model carried by both
harnesses could therefore take Claude-only `max` to Codex. It cannot happen today for the reason
above, and it is left open on purpose: the fix is a choice between refusing the review and
silently substituting the other harness's default, and both are worse than they look — refusing
loses a review over a level nobody chose deliberately, and substituting is the silent replacement
req 5 and phase 2's `--effort` decision both rule out. It belongs with whoever makes a model
dual-harness, which is the commit that makes the case reachable and the one that can test it.

## One set of controls, and a service you can choose (reqs 11, 12, 13)

Phase 3 shipped a Reviewer tab that **reports** the service and **selects** a model. Reqs 11
and 12 invert half of that, and req 13 says the result has to be the control the composer
already has. Three surfaces are involved and each was different from the other two:

| Surface | Before | After |
|---|---|---|
| Composer | `ModelSelector` + `ReasoningSelector` — borderless trigger, caret, dropdown | unchanged to look at; its trigger and rows become the shared ones |
| Reviewer tab | its own bordered `triggerClass`, its own `ModelMenu` and `ReasoningMenu` | service → model → level, all three shared |
| Background work | a native `<select>` with `<optgroup>` | service → model, shared |

**What is shared is the control, not the state.** This is the decision the whole phase turns
on. The composer's pickers carry a session's worth of machinery — an optimistic pending pick,
the echo counter that clears it, a localStorage seed, the pinned-harness rule — and phase 3
established that the Reviewer tab is deliberately **not** optimistic, because slot 2 is ranked
against slot 1 and a local guess would have to reimplement the ranking. Sharing
`useModelPickerState` would drag session state into Settings and re-open exactly that. So
`components/pickers/` holds presentation: `PickerTrigger` (the button in the reference
screenshot — label, optional leading icon, caret, disabled and locked variants), `Picker` (a
trigger plus its menu) and `PickerOption` (a row: label, optional second line, checkmark). Each
surface keeps its own state and renders the same control. There is deliberately **no shared
grouped-model-list component**: the Settings menus are scoped to one service and so have no
groups, and the composer's grouping is the only one left.

That split is also what makes req 13 **checkable**. A guard renders the composer's model
trigger and the Reviewer tab's, and asserts the two `className` strings are identical — a test
that fails the moment one surface starts styling its own button, which is how the three drifted
apart in the first place. Asserting that a shared component is *imported* would not: an import
can be present and the class overridden at the call site.

**The reasoning control shares the trigger and the rows, not the option set.** The composer's
list opens with "Default" — meaning "pass no flag, let the CLI decide" — and req 5 makes that
exact state the one a reviewer may not be in. Same control, different options, which is a
difference in the data rather than in the UI, and is why `useReasoningPickerState` (composer
precedence, `saveReasoning`) stays where it is.

**The service control picks a `(service, billing mode)` pair, never a service alone.** Two
modes of one service are two different things to a user who is asking who pays (docs/252 req
5), so the pair is the unit — the same unit the model menu already groups on, which is what
makes the two controls compose rather than overlap. Each row carries `BillingModePill`, so
req 11's subscription question is answered on the control that acts on it and not only on a
line of prose above it.

**Changing the service keeps the model when the new service offers the same model.** The
receipt records why; the design consequence is that the client cannot do this by comparing
model ids. The motivating pair — `anthropic/claude-opus-5` on a gateway and `claude-opus-5`
direct — differs as a string and is one model, which is the exact case phase 0 authored
`canonicalModelKey` for. So **`canonicalModelKey` joins `EligibleModel` on the wire**. The
alternative, re-deriving identity in the browser, is the same mistake phase 3 refused for the
harness and the level: a second implementation of a rule, in the surface least able to be
right about it.

## A picker with nothing to pick (req 14)

`Picker` renders **nothing** when its options are empty. The rule lives there rather than at
each call site, so a surface nobody has thought about the empty state of gets it anyway, and
`Children.toArray` is what makes it exact — it flattens the `.map()` callers pass and drops the
`null`s and booleans an `&&` guard leaves, so what is counted is what the menu would show.

**`disabled` was the first attempt and it does not work.** The empty service control already
carried `disabled` and its menu opened anyway: Radix binds the trigger on `pointerdown`, which a
disabled button does not reliably suppress. That is why req 14 says "not a disabled one" — the
control has to be *absent*, and a test asserting a disabled attribute would have passed against
the reported bug.

Two consequences worth stating, because both look like the rule and are not:

- **The composer keeps its trigger** (`whenEmpty="readout"`): an inert label, still no menu.
  Its row is a status line as much as a control, and `main` had *just* shipped the empty-install
  answer for it — "No model", and "Loading" only for the frame before the agent list arrives.
  Deleting that to satisfy a rule aimed at Settings would undo a considered decision on a
  surface the user meets every turn. The half both agree on — no empty menu, ever — holds on
  both surfaces.
- **A stale background-work pin is named in the warning, not on a control.** Its service offers
  nothing, so the model picker is gone; the pin the server still holds has to stay visible
  somewhere, and prose is the honest place once the control is not.

**Nothing about pinning changes.** Every one of the three controls writes the whole resolved
tuple, so pinning stays atomic (above) and *Reset to auto* stays the only way back. A service
change is a pin like any other.

**Background work gets the service control and no level control**, which is not an omission:
non-turn work has no reasoning knob to set, and inventing one here would be this document
becoming a second source of requirements for docs/252's setting.

**Phase 6 has landed.** `client/components/pickers/` holds `Picker` / `PickerTrigger` /
`PickerOption` (presentation), `ServiceSelector` (req 11) and `model-choice.ts` (the list rules).
The composer's three selectors, the Reviewer tab's three controls and Background work's two all
render them; `EligibleModel.canonicalModelKey` reaches the client.

Six things worth recording, three of which are decisions the design left open:

- **The caret rule was a genuine behavioural disagreement, not just styling.** The model trigger
  hid its caret when disabled, the reasoning trigger kept it, and the harness trigger swapped in
  a lock — three answers to one question, which is what "the same control" cannot mean. One rule
  now: no caret on a control that cannot be opened, and the lock still wins where a lock is the
  actual reason.
- **A service change carries the pinned level when the model survives by canonical key.** The
  first cut compared model *ids* and therefore dropped the level on exactly the move this feature
  added — Opus 5 from Anthropic to a gateway, where the id changes and nothing else does. Sending
  it can be *refused* by the server if the derived harness does not declare that level; that is
  the better failure, because the alternative is silently resolving to the harness's default and
  downgrading a level the user chose (req 5's one prohibition, and phase 2's `--effort` decision
  restated one surface over).
- **Background work's stale pin no longer gets a fabricated row.** The `<select>` needed one, or
  the control read as the default while the server held a pin. The triggers name the pin's own
  service and model ids instead — a worse label than a name, and a far better one than a control
  that looks unset.
- **The req 13 guard was verified by making it fail.** A divergent class was injected into one
  surface's trigger and the test went red naming that surface; the injection was then reverted.
  An assertion nobody has seen fail is a claim, not a check — the same judgement phases 1 and 5
  reached about checks that could not fail.
- **Group headers left the Settings model menus.** With the service chosen on its own control,
  every row belongs to it, so a header on each group restates the answer to a question already
  asked. The composer keeps its headers, because it has no service control (req 11's scope).
- **One requirement conflict is left open, named rather than papered over.** Cross-backend
  review put the sharpest form of it: `canonicalModelKey` proves *same model*, not *same
  harness*, so a service change that keeps the model can carry a level the newly-derived harness
  does not declare. The server refuses that (`reviewer-settings.ts`), which means the service
  change fails until the user lowers the level first — req 11 meeting req 5, with no third
  option that is not a silent replacement. It is unreachable in today's catalogue, where no
  model is dual-harness and both spellings of a model derive the same harness. The review also
  restated phase 3's already-recorded latent bug from this angle — a pin validated against the
  settings-time harness can be carried onto a different harness by `selectReviewer`. Both belong
  to the commit that makes a model dual-harness: that is the change that makes them reachable,
  and the only one that can test them.
- **Driven in the dogfood instance** across three seeded services: the two Settings surfaces
  render the reference control, the service menu carries a billing-mode pill per row, switching
  Reviewer 1 from Anthropic to OpenRouter kept **Opus 5 and High** and flipped the slot to
  *Pinned*, and the model menu then listed OpenRouter's five models rather than all eleven.

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
| 6 | Shared picker components; a service control on the Reviewer tab and Background work | 11, 12, 13 | The service is selectable with its billing mode on it; the model list is scoped to it; the composer's and Settings' triggers are the same control |

**Phase 5 was load-bearing rather than tidy-up.** Between phase 2 and phase 5, every command
ShipIt itself authored or generated for a review (`compose-review-body.ts`, the two harness
system prompts, `prompts/spec-discipline.md`) named `--agent` and nothing else, which req 7
refuses. That was the cost of the phase boundary and it was taken deliberately; it was not a
reason to widen phase 2. It is closed now, and `review-command-callers.test.ts` is what keeps it
closed.

**Phase 4 is not "confirm nothing changed".** The draft said attribution was unchanged, and
the review found that the persisted consult card carries only `subAgentId`, duration and cost
(`shared/types/domain-types/chat.ts:51`) — it cannot say which service, model or effort ran.
"Consulted Claude" is actively misleading once Claude Code can drive a non-Anthropic model, so
req 9 needs the captured target persisted on the card, under the transcript-persistence rules
in CLAUDE.md.

**Phase 4 has landed.** `SubAgentConsultCard.runOn` (a `SubAgentRunTarget`: service, billing
mode, model, effort) is copied from the target `runSubAgent` captured at admission, and
`SubAgentConsultCardRow` renders the **model** as the summary's subject with a second line
carrying service · billing mode · harness · reasoning level.

Four things worth recording:

- **The subject of the sentence changes, and that is the fix.** The card said "Consulted Codex",
  which names a *harness*. `subAgentId` stays on the card and stays visible — it is a true fact
  about which process ran — but it moves to the quiet second line, because a sentence whose
  subject is the CLI can be entirely true while saying nothing about which weights reviewed the
  work. `runOn` supplies the subject; the harness supplies the context.
- **No column, no migration, and that is not a shortcut.** The whole card serializes to one json
  column (`messages.sub_agent_consult`), so a nested field needs neither — the same reasoning
  `BranchAutoResetCard.forced` already records. What the recipe *does* still demand is the
  round-trip proof, so `EVERY_OPTIONAL_FIELD_MESSAGE`'s card carries `runOn`, and the
  finalized-row patch test asserts it survives the terminal patch: `updateSubAgentConsultCard`
  merges rather than replaces, and the terminal patch carries no `runOn` of its own.
- **Written on the PENDING card, not at completion.** docs/236 tells agents to background long
  consults, so the in-flight state is what a user looks at for minutes. A card that could not
  name its model until the run ended would be blank for the whole time anyone was reading it.
- **The ranking's own reasoning is deliberately NOT on the card.** `ResolvedSpawnTarget.reviewer`
  carries the slot, source and tier, and it stays a log line: which slot won and by which rung is
  ShipIt explaining itself, and the place for that is the Reviewer tab (phase 3), not a
  transcript row that would ask the user to hold a six-rung ranking in their head to read it.

Ids are stored and labels resolved at render (`getModel`, `serviceLabel`, the harness's own
reasoning option), each falling back to the raw id — so a model the catalogue later drops renders
as a worse label rather than disappearing, which is the rule `client/utils/service-label.ts`
already follows for service names.

**What the cross-backend review changed.** Codex confirmed the no-migration decision and found no
requirement weakened, with one finding: the checklist **overstated its own coverage**, claiming
every hop was guarded when the boot reconcile and the result read-back were not. Half of that is a
missing test and half is a false claim, and the two need opposite fixes. The boot reconcile
genuinely can drop the field — it patches a stranded card, so a regression from merge to replace
would lose it — and now has a fixture and an assertion. `getSubAgentResult` and its route pass the
stored card through verbatim, so a test there could not fail; the claim was corrected instead of
padded, which is the same judgement the phase-1 record reaches twice about checks that cannot
fail.

The audit's Services work — one card component (D2) and Services-first (D1) — is docs/252's
and is deliberately **not** in this table. It touches `ServicesPanel.tsx` /
`ProviderAccountsCard.tsx`; nothing here does, so the two can run in parallel without
conflicting.
