---
issue: planning#321
title: Custom models
description: Separate harness from service so a user can run any configured service's models on any compatible harness.
---

# 252 — Custom models

Implements [`requirements.md`](./requirements.md), which has no open questions. Every
numbered requirement is met by a phase below; where a phase's answer costs something
(activating a container to write a PR description, an estimated rather than billed cost
figure), the cost is stated rather than the requirement narrowed.

**The inventory is a separate document:** [`catalogue.md`](./catalogue.md) — every harness
and service as the TypeScript declarations phase 1 transcribes, plus a **first, unverified
pass** at the third-harness survey for Cursor CLI and OpenCode. This document is the design;
that one is its contents. Two of that pass's hypotheses are folded in below, because they
change shapes described here and the shapes are cheaper to choose now than to re-cut later.

**Visual reference — the picker:** [`mockup-picker.html`](./mockup-picker.html) — an
**interactive** prototype of the two-selector composer (harness, then model). Change the
credentials, the installed harness set and whether the session has taken a turn, and the
selectors react. It is the artifact for the picker decision below; open it and drive it
rather than reading the description.

**Visual reference — Settings → Services:** [`mockup-services.html`](./mockup-services.html)
— **interactive**. You start empty, press *Add service*, and pick service → billing mode →
credential. There is no "Available" block: the catalogue lives in the dialog. One card per
`(service, billing mode)`, matching what the picker groups on, and a subscription card holds
its accounts, their order and the routing settings.

**Visual reference — usage and cost:** [`mockup-usage.html`](./mockup-usage.html) — the usage
view split by service × billing mode, at session and global scope. Three states: a mixed
session, a session that cost nothing, and all-sessions with a weekly chart.

**Explanatory artifact — the join, drawn:** [`mockup-harnesses.html`](./mockup-harnesses.html)
— the derived service×style join, rendered to make it legible **to a reader of this document**.
It is not a screen that ships; see *No Settings → Harnesses screen* below. The
background-work setting it also shows (req 9) does ship, wherever settings for it best sit.

## The idea

ShipIt integrates **harnesses**, not models. `AgentProcess` spawns a CLI and
normalizes its event stream; the model is per-invocation data that CLI forwards to an API —
a `--model` flag for Claude Code, a field in the JSON-RPC `turn/start` payload for Codex. So
running a different vendor's model does not need a new backend — it needs the same CLI
pointed at a different endpoint (req 1).

That is the whole mechanism, and it is why this is cheap. Everything expensive in an
agent integration — the tool map, the event parsing, skills disclosure, MCP config,
steering, permission modes, plan mode — belongs to the harness and is untouched.

Untouched is not the same as guaranteed. Req 1 is **best-effort**: ShipIt adds no
limitation of its own, and it cannot fix a harness or model either. This is worth
knowing when triaging — a model that calls tools badly, ignores a plan-mode
instruction, or produces weaker diffs is behaving as that model behaves. It is not a
ShipIt defect and should not be filed or designed against as one. What *would* be a
ShipIt defect is a capability the harness and model both support failing to reach
them.

## The actual problem: `AgentId` conflates harness and service

`AgentId` (`"claude" | "codex"`) is used as three different things at once:

- **which CLI binary to spawn** — `AGENT_DEFS[].binary`, `createWorkerAgent()`
- **which credential authenticates it** — `providerAccountManager`, the auth managers
- **which models are offered** — `AGENT_DEFS[].capabilities.models`

A custom model keeps the first, replaces the second, and extends the third. There is
no way to say that today, and every awkwardness recorded in Appendix A is a symptom of
that single gap. Resolving it is the real work; DeepSeek is just the first case that forces it.

**The split the requirements settle on is three-way, not two-way** (reqs 5–6):

| Concept | Is | Identified by |
|---|---|---|
| **Harness** | a CLI to spawn, speaking **one or more** API styles ([one candidate appears to speak several](#what-a-third-harness-could-break)) | `claude`, `codex` |
| **Service** | a catalogue entry: endpoints, API styles, and per **billing mode** the models declared for each | a `serviceId` such as `openrouter` |
| **Model** | a model id a service offers under one of its billing modes | the triple (serviceId, billingMode, model id) |

A service is *not* the credential, and it is not one billing mode either. One service holds
one or two billing modes, and each mode holds zero or more user-supplied credential routes —
see the ownership table under Design, which req 12's "another subscription of the same
service" depends on.

A model id alone is **not** a global identifier: the same model is reachable through
DeepSeek directly and through a gateway like OpenRouter, at different prices and
possibly different API styles. Whatever the picker persists must therefore carry the
service identity, or "the selected model's service" cannot be resolved and req 11
cannot say which service billed a turn. This is a change from the spike.

Compatibility is **partly derived, partly declared** (req 6). Speaking a style is
necessary but not sufficient: a service also declares *which of its models* work under
each style it speaks. A model is offered on a harness when the service and the harness
**share** a style and the service lists that model under it — an intersection, since both
sides hold sets.

The declaration is not bureaucracy — it is the only honest way to express reality. The
motivating case is DeepSeek, which appears to speak both styles while supporting only
`deepseek-v4-flash` under Codex (🔍 — [`catalogue.md`](./catalogue.md) carries this as
research, not as a finding), and Codex additionally wants per-model metadata — a context
window at minimum — beyond a bare id. Under a purely derived rule, a service in that shape
would list its unsupported model and let the turn fail. Nothing forbids that at runtime — req 8 is only about
credentials — so the catalogue is where it has to be prevented, by not listing the pair
in the first place (req 6).

A consequence worth noting, though not a requirement of its own: a harness added later
picks up every configured service that speaks its style, limited to the models already
declared for it. Nothing has to enumerate harness×service pairs by hand.

This is also why "should we support OpenAI-compatible providers?" was the wrong
question. It is not a scope boundary; it is a property of each service, and it decides
which harnesses that service appears under rather than whether it is supported at all.

## Phases

Nine phases, each intended to be **one pull request**: independently reviewable, green on
its own, and leaving the product in a coherent state. They are ordered by dependency —
phase 1 is the refactor everything else needs, and the feature first works end to end at
phase 3.

Requirement numbers refer to [`requirements.md`](./requirements.md). The per-area detail
for each phase is in **Design** below; this table is the sequencing, not a second copy of
the design.

| # | Phase | Reqs | Lands |
|---|---|---|---|
| 1 | Catalogue and identities | 5, 6, 7, 15 | The data model, its launch rows and prices. No user-visible change. |
| 2 | Credentials and Settings | 5, 7, 15 | You can save a service key. It does nothing yet. |
| 3 | Spawn shaping and eligibility | 1, 2, 3, 8, 11, 16 | **A session runs on a custom service.** Turns record what billed them, and respawn on a service change. |
| 4 | In-session switching | 4 | The picker acts mid-session, across services. |
| 5 | Credential-failure policy | 12 | Correct behaviour when a credential dies. |
| 6 | Usage, cost and attribution | 10, 11, 16 | You can *see* what you are running and where the money went. (Phase 3 records it.) |
| 7 | Non-turn work | 9 | Naming and PR descriptions get their own model. |
| 8 | Model retirement | 13 | Sessions survive a model leaving the catalogue. |
| 9 | Harness install selection | 14 | Deployments choose their harnesses. |

**Phase 1 — Catalogue and identities.** The service catalogue as data: `serviceId`, the
API styles each service speaks, per style the models declared for it plus the metadata
that style needs, and a per-style endpoint. `AgentId` gains a declared **set** of API styles and stops
meaning anything else. The selected model becomes the triple
`(serviceId, billingMode, modelId)` throughout — types, persistence, and the picker's
plumbing — with each billing mode declaring its own models per style. Anthropic and OpenAI
become ordinary catalogue rows, each already carrying both modes.

**The rows themselves are written out in [`catalogue.md`](./catalogue.md)**, including the
types. So this phase is transcription for what the repo already settles, research for each 🔍
marker. **Two** shape questions stay open on purpose, both from the survey and neither
affecting a shipped harness: how a service-fused harness would be represented (Cursor), and
how a `serviceId` maps to a provider namespace for a CLI that takes `provider/model` rather
than a bare id (OpenCode) — `SpawnShape.model` expresses neither, deliberately, rather than
guessing ([`catalogue.md`](./catalogue.md)). What phase 1 is *not* is a re-derivation of
the axes. That document also settles the format: **TypeScript source, not YAML**,
because the repo already does this and the existing `CLAUDE_MODELS` shows why (a four-string
list carrying a forty-line comment about alias resolution that no YAML parser would preserve
and no test would check).

It also authors the launch rows req 15 names: Anthropic, OpenAI, DeepSeek, OpenRouter,
Vercel AI Gateway and GLM. Only Anthropic and OpenAI are reachable at this point — the rest
need phase 2's credential storage — but they are catalogue data, so they belong to the phase
that introduces the catalogue. GLM's row is the one that declares **two** billing modes on a
custom service, so it is what makes the mode-keyed shape above testable rather than
theoretical; its subscription is not reachable until phase 2 either, and whatever integrating
that plan turns out to require is per-service work req 5 keeps separate from the mechanism.

**There are three persisted model selections, not one, and two of them are easy to miss.**
The session's is obvious. The other two are not, and both become ambiguous the moment one
model id can belong to two services:

- **`vibe-model-id` in the browser's local storage** (`client/utils/local-storage.ts:49`) — a
  bare string, injected into every new session's WebSocket (`hooks/useSessionWebSocket.ts:18`)
  and used by Quick Capture. It is the seed for a *new* session's model, so an ambiguous value
  there silently decides what a fresh session bills to. It needs the triple and a migration of
  its own; a stored bare id resolves to the first service offering it, by the same
  first-eligible rule req 9's default uses.
- **Sub-agent defaults**, below.

**Sub-agent defaults are the second, and they are easy to miss.**
`SubAgentDefaults.model` is a bare `string` keyed by harness (`agent-types.ts:44`), validated
against `AgentCapabilities.models` (`services/settings.ts:275`), and the sub-agent spawn picks
its credential route from `subAgentId` *before* reading that default
(`services/sub-agent.ts:249`). Once the same model id is reachable through two services, that
string cannot say which — so it would silently resolve to the harness's own vendor, which is
the exact conflation this feature exists to remove, surviving in a corner. It becomes the
triple here alongside the session's, migrates by the same rule below, and its picker follows
the session picker in phase 4. "The selection becomes the triple throughout" has to include
it explicitly, because nothing about that phrase makes this path visible.

**Existing sessions need a billing mode, and the answer is already on disk.** The triple
needs a third element, and migration must supply it — a choice that decides what a user is
billed. It does not have to be guessed: sessions already persist **`provider_route_kind`**
(`"account" | "reserved"`) and **`provider_route_id`** (`database.ts:280`,
`sessions.ts:321`), columns that exist for exactly this distinction. So:

**Classify by route *id*, not by `provider_route_kind`.** The kind describes where a
credential is *stored*, not how it is *billed*, and the two do not line up: `claude-env-oauth`
is a `reserved` route carrying a **subscription** token — quota-bearing, ranked above metered
billing, and tracked by the limits provider alongside account routes
(`provider-account-reserved-route.test.ts:92`, `claude/limits-provider.ts:85`).

| Stored route | Migrates to | Why |
|---|---|---|
| kind `account` (any id) | `sub` | a subscription account |
| id `claude-env-oauth` | `sub` | a subscription token that happens to arrive by env |
| id `claude-api-key`, `codex-api-key` | `key` | metered |
| absent — pre-dates the columns, or no turn yet | `sub` if the service has one, else `key` | the only case with no evidence |

Only the last row is a judgement, and it fails in the safe direction: a session wrongly on
`sub` stops and says so (req 12), where one wrongly on `key` silently spends money. Two
earlier drafts got this wrong in different ways — the first ignored the columns entirely and
relabelled every key session as `sub`; the second read `kind` and would have billed
`claude-env-oauth` subscribers as metered, hiding their quota (reqs 10, 12, 16).

**The fallback has one invariant it must not break: the chosen mode has to actually offer the
model.** A session can hold a selection before any route is pinned — pinning happens at first
turn preparation (`session-agent-env.ts:399`) — so the evidence-free row is reachable with a
real model. If phase 1's research puts a model under `key` only, as the catalogue explicitly
allows for `claude-fable-5`, defaulting it to `sub` produces a triple the catalogue does not
contain, which req 8 would then refuse to offer. So the rule is: prefer `sub`, **but only
among the modes that declare this model**; if only one mode offers it, that is the answer
regardless of preference.

**The credential route belongs to a `(service, billing mode)`, and changing either must
invalidate it.** This is the sharpest edge in the whole migration, and it is not covered by
respawning. A session stores its route as a bare `{kind, id}`, and environment preparation
**reuses it unconditionally whenever it is present** (`session-agent-env.ts:359`), while
`setModel` changes only the model (`sessions.ts:813`). Left alone, switching to a different
service would respawn correctly — new endpoint, new model — and then authenticate with the
*previous* service's credential. That is not a failed turn; it is a turn billed to the wrong
account, which is precisely what req 11 exists to prevent. So the persisted route gains its
owning `(service, mode)` and is cleared whenever the selection's service or mode changes,
re-pinning on the next turn through the existing preflight.

This phase is a refactor with **no behaviour change**: the picker offers exactly the models
it offers today, now derived from the catalogue rather than from `AGENT_DEFS`. That is the
review criterion — if anything user-visible moves, the phase is wrong. It is also the
largest and least glamorous PR, and everything after it is small by comparison.

Authoring a row means establishing, per service, which API styles it actually speaks and
which of its models are declared under each (req 6). For the gateways that is research, not
recall — it must be checked against each gateway's current documentation when the row is
written, not assumed from this doc.

**The catalogue also carries per-model pricing**, because req 16's split cannot be computed
without it: `costUsd`'s provenance is not established by this repository (see below), and for
a redirected service it is produced by a CLI that was never told which vendor it is talking
to — while a subscription's "at API rates" figure has no source there at all, since no money
moved. This is a real widening of what a catalogue row costs to maintain — req 6
kept the model list short precisely to keep per-model metadata cheap, and prices move more
often than model lists do. It belongs in phase 1 because it is catalogue data and phase 1 is
where the catalogue's shape is fixed; only phase 6 consumes it. If the upkeep proves
unacceptable, the thing to drop is req 16's cost figures, not to scatter a second price
source elsewhere.

**This phase also carries the third-harness capability survey** (see *What a third harness
could break*). It belongs here because this is the phase that freezes the types the survey
could invalidate, and nowhere later is cheaper.

**Phase 2 — Credentials and Settings.** Credential storage per `(service, billing mode)`,
**with several instances per mode where that mode is a string-delivered subscription** — the
one piece of genuinely new persistence in this design, because a supplied secret today
occupies a single slot that the next write overwrites (`credential-store.ts:298`), which would
leave req 12 with nothing to fail over to ([`catalogue.md`](./catalogue.md)) —
the Settings → Services add-flow ([`mockup-services.html`](./mockup-services.html)), a
compile-time env-key name per catalogue `(service, billing mode)` — not per service, since
GLM alone declares two — and closing the compose delivery gap so a
stored key reaches a compose-backed containerized session. Existing subscription-backed
vendors keep their current credential path untouched.

**This phase breaks first-run onboarding, and that has to be said out loud rather than
discovered.** `OnboardingWizard`'s second step is hard-coded to exactly two providers — it
renders `ProviderAccountsCard` for `provider="claude"` and `provider="codex"` and lists every
other agent as read-only status
(`OnboardingWizard.tsx:249` ✅, `:256` ✅) — and it is the gate in front of the whole product
(`AuthOverlay.tsx:43` ✅). That is the same `AgentId` keying this phase removes, on the one
screen a user cannot skip. Req 8 sharpens it: a model is selectable only when its billing mode
has a credential, so on a fresh install the wizard decides whether *anything* is selectable at
all.

The **redesign** of that flow is a separate feature with its own requirements, because it is a
first-run experience question rather than a data-model one and it reaches things this design
has no opinion about. What belongs *here* is only the interim: this phase must leave onboarding
able to connect at least one credential and reach a runnable model. The cheapest honest version
is to keep the two cards and re-point them at `(anthropic, sub)` and `(openai, sub)`
explicitly, which preserves today's behaviour under the new keying without pretending to be the
final design. Getting this wrong is the same failure mode as the phase 3 / phase 6 `cost_usd`
interval below — a phase that is coherent in isolation and ships a broken product for the
length of one PR.

It also **re-keys the routing settings** from per-`AgentId` to per-`(service, mode)`. The
real names, which an earlier draft of this paragraph got wrong: **`accountSelectionMode`**
(`"strict" | "balanced"`, default `strict`) and **`failoverCutoffs`** (`{ session, weekly }`,
both defaulting to 90), both stored in `CredentialData` and both currently
`Partial<Record<AgentId, …>>` — that `AgentId` key is the thing this phase changes. Order is
**`priority`**, not `isPrimary`: `isPrimary` survives on the wire shape but is *derived* on
read as `index === 0` after sorting (`provider-account-manager.ts:299`), so re-keying must
follow `priority` and leave the derivation alone. They move here rather than into phase 5
because they are Settings state, and because a subscription card is meaningless without them.

**API-key storage is asymmetric today and phase 2 is where that gets levelled.** Codex's
`OPENAI_API_KEY` is persisted in `CredentialData.agentEnv`; Claude's `setApiKey()` only
assigns `process.env.ANTHROPIC_API_KEY` and writes nothing (`services/settings.ts:367`). One
of the two custom-service credential paths therefore already exists and the other does not,
which is worth knowing before estimating this phase as symmetric work.

**It also owns GLM's subscription integration** — whatever that turns out to consist of —
because req 15 makes a working custom subscription a launch commitment, not just a catalogue
row. The current research says its coding plan is authenticated by a supplied key rather than
a login flow ([`catalogue.md`](./catalogue.md), 🔍), in which case there is no OAuth dance to
build and the work is quota reporting plus delivery; an earlier draft asserted "login, token
refresh and account handling" as though that were established, which the 🔍 marker on the
entire GLM row forbids. This is the phase's one genuinely per-service piece of work, and the only
place in these nine phases where a *vendor* rather than a *mechanism* is being built. It is
the least predictable item in the plan for that reason: everything else here is shaped by
ShipIt's own code, and this is shaped by whatever GLM's plan actually offers. **If it slips,
it does not block anything** — phases 3 to 9 depend on the billing-mode mechanism, not on
GLM — but req 15 is unmet until it lands, which is the honest status to report rather than
counting the catalogue row as done.

Ends with a key you can save, edit and remove, that is delivered to the session container
and used by nothing. Shipping this alone is deliberate: credential storage and delivery is
where the security-relevant review is, and it deserves a PR that isn't also changing how
turns run.

**Phase 3 — Spawn shaping and eligibility.** Both spawn sites set the base URL and
credential from the selected model's service, after the scrub. **There is no existing
base-URL seam to extend** — no field on `AgentRunParams`, no Claude flag or env assignment,
no Codex provider config written, no per-invocation override anywhere — so this is new
surface rather than a widened parameter, and it is the largest single piece of this phase.
The model reaches the two CLIs by different mechanisms too: Claude takes `--model` as a
process argument, while Codex spawns `app-server` and sends the model in the JSON-RPC
`turn/start` payload, so "set the model" is two implementations, not one. Eligibility moves from
`hasAnyAuthForProvider(provider)` to the per-billing-mode credential question, which is what
stops `claude-*` models being offered on an install whose only credential is a DeepSeek key.

**Phase 3 must also widen the resident process's spawn identity, and sequencing that into
phase 4 is a bug.** The guard that forces a respawn compares two model *strings*
(`resident-model-guard.ts:40`), so a switch between two services offering the same model id —
`deepseek-v4-flash` direct versus through a gateway — looks like no change at all and reuses
the running process, with the previous service's endpoint and credential. Phase 3 is the phase
that makes the picker service-grouped, so it is the phase that first makes that switch
*reachable*: leaving the identity widening until phase 4 means phase 3 ships a version where
choosing a different service silently bills the previous one. That breaks req 11 and the
"coherent on its own" rule these phases are built on. The identity becomes the whole
spawn-relevant tuple here — harness, service, billing mode, model, style, endpoint, credential
route — and phase 4 is then only the picker acting mid-session.

**Phase 3 also widens the per-turn usage record, and it has to — this is the one ordering
mistake in these phases that cannot be repaired later.** `UsageRow` stores a bare `model` and
a `cost_usd` with no service and no billing mode (`usage.ts:28`), and session and global
queries just sum that column (`usage.ts:240`). The moment phase 3 lands, turns start being
recorded that phase 6 will be asked to split by `(service, mode)` — and *cannot*, because the
same model id can come from two services and two modes, and the session's current selection
says nothing about what an earlier turn ran on. So the row gains `service_id`, `billing_mode`
**in the phase that starts producing such turns**, not in the phase that reads them. (The
resolved API style is deliberately *not* stored: req 16 groups by service and mode, pricing is
keyed by service/mode/model, and nothing names a reader for historical style — so it would be
a column and a migration with no consumer.)

**The cost semantics have to be settled here too, and the phase boundary is where they bite.**
`cost_usd` as recorded is already a **delta** ShipIt computes, because Claude Code's
`total_cost_usd` is a running conversation total rather than a turn cost (`usage.ts:115`). For
a custom service that delta is the CLI's price table applied to the wrong vendor's tokens, so
it cannot be the figure ShipIt reports.

Phase 3 writes rows; phase 6 reads them; they are separate PRs and each is meant to be
independently coherent. So phase 3 has to say what `cost_usd` means **in the interval**, while
the existing readers — which just `SUM(cost_usd)` (`usage.ts:240`) and label it "Cost" — are
still the only readers. Three ways to get this wrong, all of which ship a wrong number to a
real user for the length of one PR:

- Leave `cost_usd` as harness telemetry and custom-service sessions keep showing the CLI's
  price table applied to another vendor's tokens.
- Put the subscription "at API rates" value in it and the existing `SUM` labels notional plan
  usage as money spent — the exact conflation req 16 exists to end.
- Write a catalogue-computed *per-turn* amount through today's `record()` and it gets
  **delta'd again**: that path treats any non-sub-agent value as cumulative and subtracts the
  previous one (`usage.ts:134` ✅), so a correct per-turn figure comes out as the difference
  between two consecutive turns.

So `cost_usd` keeps **one** meaning from phase 3 onward — *money that left the account for this
turn* — and phase 3 writes it under the final rule from day one: the harness figure for a
native key turn that reported one, the persisted rates for every other key turn, and **zero for
a subscription turn**. The existing `SUM(cost_usd)` stays correct under that definition without
being touched, which is what makes the phase split safe.

That third failure mode also forces a fix rather than a convention: **the cumulative-to-delta
conversion has to branch on the source of the value, not on `subAgentId`.** Today `record()`
infers "cumulative" from "not a sub-agent" (`usage.ts:141` ✅) — true only while the sole
producer is Claude on Anthropic. A rate-derived figure is already per-turn and must not be
delta'd; the caller knows which it has and the column does not. The signature gains that
discriminator in this phase.

The visible consequence of the zero: a Claude subscription session's dial and usage modal stop
showing a dollar figure they show today. That is req 16's decision, not this phase's — but
*what those surfaces show instead* is an open question in `requirements.md`, and phase 6 owns
whatever the answer is.

**Rows written before this exists get an explicit `legacy` attribution, and are not
backfilled.** Req 16's split holds "across all sessions", so old rows need somewhere honest to
go, and their true attribution is not recoverable: a historical row has a model string and no
route, and sub-agent rows carry `sub_agent_id` without any billing information at all
(`services/sub-agent.ts:457`), so the parent session cannot answer for them either. Guessing
would produce a confidently wrong split of real money. A named bucket the UI can render as
"before ShipIt tracked this" is the honest option, and it drains on its own as old sessions
age out.

So each new row stores **tokens, attribution, and the rate that was applied** — not a price
looked up later. The rate always comes from the catalogue; which *column* that rate ends up
feeding is [`catalogue.md`](./catalogue.md)'s rule, keyed on billing mode. Concretely,
`RecordedTurn` gains `service_id`, `billing_mode`, and the four unit rates in force (`input`,
`output`, `cacheRead`, `cacheWrite`).

The rates are stored on **every** new row including the native-key rows whose `cost_usd` came
from the harness, because the two answer different questions: `cost_usd` is what was billed and
the rates are what the catalogue said at the time. Storing them costs four columns and makes
the native rows auditable against the table instead of opaque; omitting them would make
native-key the one row shape that cannot be re-derived.

**Two producer-side gaps this phase has to close, both verified rather than assumed:**

- **The sub-agent writer passes no model and no route.** `record()` is called with
  `subAgentId`, cache and context fields only (`services/sub-agent.ts:470` ✅), so a sub-agent
  row today cannot say what it ran on. Phase 3's all-or-nothing `CHECK` would reject it. The
  writer widens here, in the same phase that adds the constraint — not later.
- **Codex's token semantics are unestablished, and the rates now always apply to it.** Whether
  `inputTokens` includes `cachedInputTokens` is upstream app-server behaviour this repo does
  not pin down 🔍 ([`catalogue.md`](./catalogue.md) has the detail). Claude's are disjoint
  (`claude/adapter.ts:292` ✅). If Codex's overlap, every Codex turn double-charges the cached
  tokens at the full input rate. This is a spike in phase 3, and normalization belongs at the
  adapter boundary so the pricing code can assume disjointness.

**These are all-or-nothing, not independently nullable.** Either every one is present or every
one is null; there is no such thing as a row that knows its service but not what it was
charged. Independent nullable columns would let a caller write half a row, and since
historical attribution cannot be reconstructed afterwards, a half-row is unrecoverable in
exactly the way this whole paragraph exists to prevent. A `CHECK` constraint enforces it at
the one place that matters — the write — rather than a convention every future caller has to
remember.

All-null is the `legacy` bucket. It needs no extra discriminator and no widening of
`BillingMode`, which stays `"sub" | "key"` and describes a *selection* rather than a row's
provenance: a legacy row is one written before this existed, the aggregation groups it under
its own heading, and it never guesses which service it belonged to. Computing money at read time from the live catalogue was this doc's first answer and
it is wrong in two ways that only show up with time: a price edit would silently restate every
historical "You paid", and a retired model would have no price to look up at all — which the
already-declared `gpt-5.6` retirement demonstrates. Req 16 asks where money *was* spent, which
is a fact about the past. Persisting the unit rate alongside the tokens is what makes it one;
the catalogue then supplies the rate for *new* turns only.

It is also where req 3 becomes observable: the moment a custom model is offered, it is
offered in the one picker alongside everything else, with no separate surface for a
vendor's own models. The composer's picker splits in two here — harness and model as
separate controls, model rows grouped by service — because this is the phase where
harness-as-group-header stops being able to express the list.

**This is the phase where the feature exists.** A fresh session on DeepSeek V4 Flash under
the Claude Code harness takes a turn, with no Anthropic credential anywhere. The spike
already established this works (Appendix B); this is the version that follows the
requirements.

**Phase 4 — In-session switching.** The resident process's identity was already widened in
phase 3 — to the whole spawn-relevant tuple: harness, service, billing mode, API style,
endpoint, credential route, model — because phase 3 is where a same-id/different-service
switch first becomes reachable. Phase 4 is only the mid-session *interaction* on top of it:
the picker acting on a live session, across services rather than just within one.

**Phase 5 — Credential-failure policy.** Branch on the **billing mode** of the failing
selection rather than on the error text, and never on how its credential is delivered. Two gates, not one: the auth-error
interception must not drag a key-authenticated service into vendor re-auth, and the
same-turn quota retry needs the same billing-mode gate that account benching already
has. Establish Codex coverage rather than assuming it.

**Phase 6 — Usage, cost and attribution.** Quota reporting moves from `AgentId → routeId` to
per-`(service, billing mode)` **→ route** — the outer key moves, the per-credential inner key
stays, because two subscriptions have independent windows — with a mode that reports no quota
rendering nothing at all.
Attribution surfaces the active model, its service and its billing mode — in the surfaces
that already exist, not in new composer chrome (see below). The usage view splits spend and
plan usage by `(service, mode)` (req 16), which needs the price table phase 1 carries.

**The aggregation contract, stated once so an implementer does not have to infer it from the
mockup:** "at API rates" **recomputes** from each row's persisted rates and tokens; "metered
spend" **sums** the stored `cost_usd`. The two never read each other's source, and neither
reads the live catalogue. This follows from [`catalogue.md`](./catalogue.md)'s rule — the
column decides the source — and it is the thing that makes a retired model's history still
valuable and a price edit unable to restate the past.

**Legacy rows are excluded from both figures, not just from the split.** Their attribution is
unknown, which the legacy bucket already handles — but their *dollar* meaning is unknown too,
and that has not been said. A legacy row's `cost_usd` may be a Claude cumulative delta, or one
of the acknowledged over-counted pre-migration values (`docs/013`), or a Codex zero that means
"reported nothing" rather than "cost nothing". Summing those into "metered spend" would put a
number of unknown provenance into the column req 16 exists to make honest, and they have no
persisted rates so they cannot contribute to "at API rates" at all. The legacy group therefore
shows **turn and token counts and its own unqualified dollar total, labelled as pre-feature
accounting** — carried forward as what the user has already seen, not merged into either new
figure. The mockup needs a rendered example of this group; it currently has none.

**The inherited cost surfaces need a decision, and the requirements preamble makes it
mandatory.** This design's mockup covers the headline totals and the weekly chart, but a dollar
figure computed from `cost_usd` also appears in the context dial's trigger and popover
(`ContextDial.tsx:216` ✅), and in the usage modal's per-session "Cost", "Avg / turn", per-turn
column and by-spend session ranking (`UsageModal.tsx:315` ✅, `:321` ✅, `:419` ✅, `:445` ✅).
Every one of them silently changes meaning the moment `cost_usd` becomes key-only: a
subscription session reads zero across all of them, and a mixed session's "Avg / turn" divides
metered spend by a turn count that includes subscription turns. The dial is the sharpest case
and it is the open question in `requirements.md`; the modal's own surfaces follow whatever that
answer is, and the by-spend ranking needs an explicit tiebreak once many sessions are legitimately
$0. None of this is new mechanism — it is the same split applied to the surfaces that already
exist, which is what "reporting usage is not new; the split is" implies.

This is the phase most likely to want splitting in two: the quota/attribution half is a
re-keying of existing machinery, while the cost half (req 16) depends on the price table phase
1 authors and on the open question above.

**Phase 7 — Non-turn work.** Session naming and PR descriptions get their own explicitly
chosen `(service, billing mode, model)`, visible as a setting whose unset state resolves to
the first eligible model rather than to a named one. Includes
normalizing a blank PR generation into the generic fallback — today's code returns the
empty string in containerized production — and the durable, dismissible failure notice.

The largest phase after the first, because it is the one place with no existing seam.

**Phase 8 — Model retirement.** Per `(service, billing mode)`, a record of each retired model
— its id, the styles it was declared under, and a successor per style (`RetiredModel`) —
resolved where the session's model is read, generalizing the existing
`normalizeCodexModelId` shim. Small, but it is what lets curation happen without stranding
sessions, so it should land before the catalogue is trimmed in anger.

**Phase 9 — Harness install selection.** Which harnesses a deployment installs becomes a
build input, defaulting to Claude Code and Codex. This supersedes the never-implemented
sketch in `docs/154-cursor-agent-adapter`, which proposed the same mechanism
(`INSTALL_*_CLI` booleans written to `/opt/shipit/agents/installed.json`) for the same
reason. Last because nothing else depends on it, and because it is the phase most likely
to be deferred — though not for free: req 14 is unmet until it lands, so deferring it is
a requirement left open rather than a phase skipped.

## What a third harness could break

This design is derived from two CLIs, and `AgentId`'s conflation is the standing proof that
a model derived from too few cases hardens into the wrong shape. Adding Cursor
(`docs/154-cursor-agent-adapter`) or OpenCode later should not force a re-cut of the
catalogue — so their capabilities are **surveyed during phase 1**, before the types are
frozen, and integrating them stays out of scope.

**A first pass has been run and is in [`catalogue.md`](./catalogue.md)** — from documentation
rather than from the CLIs, so every cell is marked unverified. It already found two
contradictions, both in the rows called out below as the expensive ones, and both are folded
into this section. Phase 1 confirms them against the actual binaries; the value of having
them now is that the types below are being designed with the answers rather than around them.

The survey's purpose is narrow: answer these questions for each candidate, and check whether
any answer contradicts an assumption below. Each assumption is stated with what it would cost
to be wrong.

| Assumption | Where it lives | If a harness violates it |
|---|---|---|
| **A harness speaks exactly one API style** | the service×style join, `AgentId → style` — **not** req 6 | The join becomes many-to-many and a harness needs a *set* of styles. Cheap now, invasive later. |
| The **model is a per-invocation argument** | spawn shaping, req 4's respawn boundary | A config-file-only CLI needs a per-session config written before each spawn; mid-session switching changes shape. |
| The **endpoint is overridable per invocation** | spawn shaping, the whole feature | A CLI reading one global config cannot host two sessions on two services at once. |
| **A raw API key can authenticate it** | req 2, req 5 | An OAuth-only CLI cannot use a key-authenticated service at all, so it offers a narrower catalogue than the join implies. |
| **Reasoning is an enum flag** | docs/217, `AgentCapabilities.reasoning` | A numeric budget rather than named levels needs a different control, not a different option list. |
| **Per-turn usage is reported** | req 10, the usage screen | A harness reporting nothing leaves rows with volume and no cost — survivable, but the screen must not assume. |

**The first row is the one to check first.** It is the assumption most likely to be wrong and
the most expensive to fix late: OpenCode is a multi-provider CLI by design, so "one harness,
one style" is exactly the shape it would contradict. If a harness can speak several styles,
then `(harness, service)` compatibility is a set intersection rather than an equality test —
a change to every join built on it. Discovering that in phase 1 is a type change;
discovering it after phase 6 is a re-cut of the catalogue, the picker and the usage
grouping.

**Req 6 is deliberately not on the hook for this one.** It states the rule as an overlap —
a model is offered when the service and the harness *share* a style — which holds whether a
harness speaks one style or several. So a contradicted row is a design cost and not a
requirements change, which is the point of phrasing it that way. (The one-style assumption is
already gone from the data shapes: `styles` is a set on both sides. This row remains in the
table because the survey has not been *run*, not because the design still assumes it.)

**And it appears to be contradicted** — from documentation, not from a run: OpenCode
integrates the Vercel AI SDK and the models.dev registry across 75+ providers, which would
mean it speaks many styles by construction. That is enough to make `HarnessDef.styles` a
**set** rather than a scalar and the join an intersection, since the set costs nothing if the
hypothesis is wrong and costs a re-cut if it is right and discovered late. Rewriting req 6 as an overlap earlier today turned out to be the difference
between a type change and a requirements change; that was luck as much as foresight, but it
is the reason this costs a field rather than a round of re-approval.

**The third row appears to break too, and differently.** OpenCode's endpoint and credential
are documented as living in `opencode.json` rather than in flags or environment variables —
which would mean driving it requires **writing a per-session config file before each spawn**,
a shape `SpawnShape` carries and no current adapter implements. Its reasoning setting is a
config key whose levels come from the *provider* rather than the CLI, which is the one place
docs/217's harness-keyed reasoning model fits badly. Neither is fatal; both are work that
would otherwise surface inside phase 3.

**Cursor CLI raises a question the table does not ask.** It authenticates to *Cursor's own*
service with `CURSOR_API_KEY` and selects from Cursor's lineup; if it has no supported
base-URL override, it is a CLI permanently fused to one service — which is the very
conflation this feature exists to undo, arriving from the outside. It would join as a fixed
`(harness, service)` pair whose service is not user-configurable, rather than as a harness
that joins the catalogue. Worth deciding deliberately; `catalogue.md` lists it first among
what phase 1 must check.

Note this is a **survey, not an integration**. Nothing here proposes shipping a third
harness; req 14's install-time selection already covers how one would arrive. The deliverable
is the filled-in table and, if a row is contradicted, a decision made while it is still
cheap.

## Design

Settled by the 2026-08-05 answers. **Every service is ShipIt-defined** (req 5) — there
is no user-authored service, only user-supplied credentials for services ShipIt ships.
This feature builds the **mechanism** for both billing modes (req 5): a catalogue service
can declare a subscription, and the picker, Settings, eligibility, usage and failover all
handle one without knowing whose it is. Integrating a *particular* vendor's subscription —
its login, refresh and account handling — stays per-service work, so which services ship one
is req 15's question. Req 15 answers it for the launch set: **GLM**, whose integration phase
2 owns (below).

**Data model — two layers, with different owners.**

*ShipIt ships the catalogue* (req 6): which services exist, which API styles each
speaks, and per style, which of its models work there plus any metadata that style needs
(a context window at minimum). This must be
a **maintained subset**, not a mirror of everything a service offers (req 6). Only a
handful of models are worth using for coding at any time, so an aggregator advertising
400+ models contributes a short curated list rather than 400 rows.

Per-model metadata — the context window, the display label, the price — is simply stated
per model, there being few enough of them. **Reasoning is deliberately not among them**: it
stays keyed to the harness (see the explicit non-change below), so the catalogue carries no
reasoning field. The cost is a judgement call
ShipIt owns and revises: which models are worth carrying. A per-style endpoint belongs here too:
one base URL per service is wrong for a service whose styles live at different paths.

*The user supplies credentials* (req 7) for the services they want to use. That is the
whole of what they own; they are not authoring catalogue entries. The consequence is
explicit in req 7 — a service ShipIt does not know about needs a ShipIt change.

**Which is why the catalogue's launch contents are themselves a requirement** (req 15).
With no user-supplied endpoints, an empty-ish catalogue would make the feature true on
paper and useless in practice, so the shipped set is specified: Anthropic and OpenAI
first-party, DeepSeek as the direct key-authenticated case, OpenRouter and Vercel AI
Gateway as the gateways, and GLM as the custom service carrying a subscription. The rows
themselves are in [`catalogue.md`](./catalogue.md).

**A gateway needs no mechanism of its own** — that is the whole point of having settled on
the service as the primitive. It is a row with a key that happens to reach many upstream
vendors, and every part of the design already covers it: curation keeps its hundreds of
models to a handful (req 6), the pair identity distinguishes its `deepseek-v4-flash` from
DeepSeek's own, and attribution names it as the service that billed the turn (req 11).
If adding OpenRouter needs anything the design does not already have, that is a signal the
service abstraction is wrong, not that gateways need special handling.

One consequence is worth stating because it reads as a bug and is not: a gateway key can
make a vendor's own models available to a user with no account at that vendor, and — since
a gateway commonly speaks a style its upstreams do not — can offer them under a harness that
vendor did not write. A vendor's models reached through a gateway, on the other harness, is
reqs 2 and 6 working exactly as specified. The eligibility check must not acquire a "but
these are really Anthropic's models" special case to prevent it.

Which *specific* crossings exist depends on API styles nobody has verified. The spike's notes
say OpenRouter serves an Anthropic Messages endpoint alongside OpenAI-style ones (Appendix A),
which would put Anthropic models under **Claude Code** via OpenRouter — but that is a claim
about a vendor, not about this repository, so it is an item on
[`catalogue.md`](./catalogue.md)'s phase-1 checklist and not a fact this design may lean on.
The more striking illustration, Anthropic models under **Codex**, additionally needs
OpenRouter to speak the Responses API, which nothing here establishes.

**User-supplied endpoints are deferred, not designed away** (req 15). Nothing here should
foreclose them: a service row is already `(endpoints, styles, declared models)`, which is
the same shape a user-supplied one would need, so the later feature is a new *source* for
catalogue rows rather than a new concept. Do not add a mechanism for it now.

**Four distinct identities.** A service is not a credential and not an endpoint; req 12's
"another subscription of the same service" only makes sense once they are separated:

| Thing | Owner | Example |
|---|---|---|
| `serviceId` | ShipIt catalogue | `openrouter` |
| **billing mode** | ShipIt catalogue, per service — `sub` or `key`, each declaring its own models | GLM `sub` (its coding plan) vs GLM `key` |
| credential route | the user — one key, or one subscription account, within a mode | a stored key, or `acct_…` |
| selected model | the session | `(serviceId, billingMode, modelId)` |
| turn route | resolved per turn from the credential routes **of that mode** | which key/account this turn used |

One catalogue service can therefore hold several credential routes, which is exactly the
case req 12 fails over between — but only *within* a mode.

**The billing mode is selected; the credential route is not** (req 5). Resolving the mode per
turn — on the grounds that the account manager already walks accounts before falling back to a
metered key — describes how the code behaves and is the wrong basis for the decision. The two
modes are not interchangeable the way two subscriptions are:

- **Their model sets can differ.** A plan tier need not include everything the API sells, so
  a merged list offers a model the resolved route cannot serve (req 6).
- **Their prices differ**, which is already the reason this design lists the same model id
  separately per service. Included-versus-metered is that same distinction inside one
  service, so merging them contradicts the rule that justifies the pair.
- **Failover never crosses them** (req 12), so a merged entry leaves a user with a spent
  subscription and an unused key unable to say "charge me, keep working" — the same class of
  dead end req 9 exists to prevent.

Several *subscriptions* to one service still collapse into one mode: req 12 routes between
them and the user never picks among them. So the picker's grouping key is
`(serviceId, billingMode)`, which is at most two groups per service rather than one per
credential.

Anthropic and OpenAI are catalogue rows like any other, not special cases (req 5).
`AgentId` keeps meaning *harness* only, and gains a declared **set** of API styles — a set
rather than a scalar because a survey candidate appears to speak several (OpenCode),
so the service×harness join is an intersection. An intersection can hold more than one style,
so the resolved style is **the first of the harness's styles the model also declares**
([`catalogue.md`](./catalogue.md)); it is resolved rather than selected, and rides the spawn
identity alongside the endpoint and credential route. Both shipped harnesses declare one
style, so this is a no-op until a multi-style harness arrives.

The picker's list for the active harness is then every `(service, billingMode, model)` the
catalogue declares under a style the harness shares, filtered to modes with a usable
credential **that this harness can carry** (reqs 6, 8). Those are one test, not two, and
writing them as two is a real bug: a mode may *accept* both an account and a string while the
user has configured only one of them, so "the mode has a credential" and "the mode declares a
shape this harness supports" can both be true of *different* credentials. Concretely — an
Anthropic subscription with only an OAuth account connected, offered to a key-only harness:
the mode has a credential, the mode declares a `string` shape the harness supports, and the
model is offered and cannot authenticate.

So the predicate is over **configured routes**: is there a route in this mode whose `via` the
harness has a target for? That is the check `CredentialTargets` exists to feed, and stating it
over modes rather than routes reintroduces exactly the ShipIt-imposed failure req 1 rules
out. Note the entry is the **triple**, not the model id — the same id can come from
more than one service, and from two modes of one service, at different prices.

It stays **one model picker**, listing every eligible model the same way regardless of which
service provides it (req 3). A vendor's own models must not get a separate surface or a
privileged position in this one — that is the same rule as "Anthropic is a catalogue row
like any other", seen from the UI side.

**Two selectors, not one: harness and model separate** ([prototype](./mockup-picker.html)).
Today `ModelAgentSelector` is a single dropdown whose group headers are *harnesses*, because
harness and provider are the same thing. Once they are separated, that grouping is wrong
twice over: the group header is needed for the **service** — which is what the credential,
the price, the billing pill and the usage indicator all hang off — and the harness stops
being a group at all. It becomes an axis that selects *which* list you are looking at.

This does not touch req 3, which is about models: model selection stays one list in one
place. The harness is a different choice with different consequences, and the decisive one
is that **it is not reversible**. Per-agent credential isolation pins the harness for life
at the first turn (`docs/138`), while models stay switchable (req 4). Today that asymmetry is
rendered as greyed rows and a lock badge on a group header *inside* the model menu, so the
single most consequential fact about the session is visible only to someone who opens a
dropdown and reads it. Two controls make it structural: one is disabled with the reason on
it, the other is fully live, and both are legible on the closed composer.

The split has one real cost and one new interaction, both worth deciding deliberately:

- **The other harness's models stop being visible in one list.** The combined picker showed
  everything and greyed what you could not have — worse as a lock affordance, better as a
  map. The obvious patch is a footer on the model menu ("3 more models on Codex"), and it is
  the wrong one: it grows with every installed harness, and it is useless the moment the
  harness is pinned, which is most of a session's life. The answer instead is that the
  **harness menu states each harness's model count on its own row** — the information lands
  on the control that would act on it, and one line per harness in a menu that already lists
  harnesses does not accumulate into clutter.
- **Switching harness can strand the selected model.** Keep the model when the new harness
  also offers that exact `(service, billing mode, model)` triple — which is what would carry
  `deepseek-v4-flash` through a Claude Code → Codex switch, *if* DeepSeek turns out to serve
  it under both harnesses' styles ([`catalogue.md`](./catalogue.md) marks that unverified) —
  and otherwise move to the first eligible model and say so.
  Landing somewhere else silently would contradict req 11; refusing the switch would make an
  enabled control lie. The combined picker never had this case, because there the harness and
  model moved together by construction.

A third case looks new and is not: removing a service's credential mid-session strands the
selection with no successor to move to (req 13's map never crosses services). Req 12 already
answers it — an API key does not fail over, so ShipIt stops and says so. The split only
changes *where* that surfaces, from a failed turn to a picker state you can see before
sending.

**The picker states what you choose on, and nothing else.** Everything the split makes
*expressible* is a candidate for showing, and almost none of it earns composer space. What
survived, and what did not:

- **No labels on the triggers.** A product name and a model id do not need the words
  "harness" and "model" in front of them. The closed composer is
  `Claude Code ▾ | deepseek-v4-flash ▾ High ▾` — three controls, since reasoning
  (docs/217's per-session control) sits beside the model as it does today.
- **The service pill is disclosure-on-demand**, appearing only when that model id is offered
  by more than one eligible group on this harness. That is the sole case where the id alone
  cannot say who is billing you — exactly the case the identity exists for — so it shows up
  when the ambiguity is real and costs nothing otherwise. It names the **billing mode**
  ("Subscription") when the duplicate rows are within one service, and the **service**
  ("OpenRouter") when they cross services, because that is the axis that actually differs.
- **No API style anywhere in the picker.** `anthropic-messages` / `openai-responses` is
  ShipIt's vocabulary for why a join holds; it is not a fact anyone chooses on. Each harness
  row states its **model count** instead, which is the same information in the form the
  decision needs. API styles are not shown anywhere in the product at all: explaining why a
  service appears under one harness and not another is this document's job, not a screen's.
- **No explanatory footers.** Neither "N more models on Codex" nor "installed at deploy time
  — nothing to add here". The first is covered by the harness rows' counts; the second by the
  absence of an add affordance. A menu that has to narrate itself is the wrong menu.

The through-line: this feature adds three new axes (harness, service, API style) and the
temptation is to surface all of them because they are newly nameable. Only the ones a user
acts on belong in the composer; the rest belong in Settings, where explaining the join *is*
the screen's purpose.

**Attribution needs no new surface** (req 11). Once the harness and the service are on the
composer's two triggers, "which model, which service, key or subscription" is already on
screen or one click away: the model trigger carries the model and its service, and the model
menu's group headers carry the billing kind. Req 11 asks that the user *can tell* — not that
it be restated permanently — so a standing "Running *model* via *service* on *harness*" row
under the composer is redundant chrome and was cut from the prototype for exactly that
reason.

What still needs doing is smaller than a new surface: `UsageModal` already shows a **Model**
stat (`UsageModal.tsx`), and that is the established home for "what actually ran" — a
comment in `ModelAgentSelector.tsx` already names it as such, having moved live-model display
there once. Service and billing kind join it there. Attribution is then two places with
distinct jobs: the picker answers *what will run next*, the usage modal answers *what did
run* — which is the same split the selector's precedence rules already maintain between the
persisted selection and the CLI's last-reported model.

**Full separation is the point.** No code path should ask "which vendor's agent is
this?" to decide anything about credentials. Concretely, req 2 means a user with only a
DeepSeek key runs the Claude Code harness with no Anthropic account anywhere in the
system — so `providerAccountManager`'s per-`AgentId` account model has to become a
per-*service* one, not gain a fallback branch.

**The harness set is a deployment property** (req 14). Nothing in Settings adds, defines or
removes a harness. Which harnesses an install *has* is a session-image build input, defaulting
to Claude Code and Codex.

**So there is no Settings → Harnesses screen**, and dropping it is a real scope cut rather
than a deferral. Nothing in it was required: no requirement asks a user to see API styles, and
req 14's demands — install-time selection, defaults, and uninstalled harnesses appearing
nowhere in the picker — are satisfied by the picker and the build, with no read-only page to
explain them. A screen whose whole content is *why the product looks the way it does* is
documentation that has been rendered as UI; the audience for the service×style join is
whoever reads this doc, which is why the mockup stays an explanatory artifact. The
background-work model setting (req 9) is a separate obligation and does ship.

**It is a property of *two* images, not one, and an earlier draft only designed for one.** The
orchestrator image and the session-worker image each install the CLIs independently
(`docker/Dockerfile.prod:45`, `docker/Dockerfile.session-worker.prod:108`), and the
orchestrator does not merely record the set — it probes **its own** binaries to decide what
the picker offers (`agent-registry.ts:375`) and runs session naming locally
(`session-namer.ts:22`). So a selection written only into the worker image would leave an
uninstalled harness still listed in the picker and still used for background work. The
installed set has to be authoritative across the boundary: one input, consumed by both image
builds, with the orchestrator reading the declared set rather than trusting a probe of
whatever happens to be on its own `$PATH`.

This is not a new mechanism — `docs/154-cursor-agent-adapter` specified it and was never
implemented: `INSTALL_CLAUDE_CLI` / `INSTALL_CODEX_CLI` / `INSTALL_CURSOR_CLI` booleans
consumed by the image build, with the result written to `/opt/shipit/agents/installed.json`
for `AgentRegistry` to detect. Req 14 adopts that design and supersedes the doc; the parts
of docs/154 that remain distinct are the Cursor **adapter** itself and its stream parsing,
which this feature does not touch.

Consequence worth stating because it is easy to get backwards: *installed* and
*credentialed* are different gates. A harness that was not installed offers nothing
regardless of credentials, and a harness that was installed still offers only the models
whose service has a credential (req 8). The picker's filter is the conjunction, and an
uninstalled harness should be absent rather than shown-and-empty.

**Settings → Services is an add-flow, not a catalogue listing.** Two layouts were
prototyped and this one was chosen; the rejected one (a Connected/Available listing of every
service ShipIt knows, with billing modes nested inside each service card) has been deleted
rather than kept, so nothing in this folder still shows it.

The screen is a list of **what you configured**, not of what exists. It starts empty; the
catalogue appears inside the add dialog, at the moment it is a choice. That keeps the screen
proportional to the user's setup rather than to ShipIt's — the rejected layout grew with the
catalogue whether or not any of it was used.

The discoverability cost was weighed and accepted: req 15 makes the shipped catalogue a
promise, and a listing answers "which services does ShipIt support?" at a glance where this
needs a click. The judgement is that someone who needs OpenRouter or Vercel is looking for
it and will find it.

Two things make the add-flow the better fit rather than merely the tidier one:

- **Step 2 asks how you pay for it**, showing "Subscription — 1 model" against "API key —
  2 models". The distinction the picker groups on is one the user makes deliberately, rather
  than discovering later inside a nested card.
- **A card is one `(service, billing mode)`** — exactly the picker's grouping. An earlier
  draft made every credential its own row, so two Anthropic subscriptions were two rows in
  Settings and one group in the picker, with the two surfaces counting differently. Grouping
  by service × mode removes the mismatch rather than explaining it.

**The routing settings are why the card is the group.** Order, *Use in order* vs *Spread
across accounts*, and the failover cutoffs are all answers to "which of these accounts
next?" — a question that only exists where there is a group to choose from. Today they are
per-`AgentId` (`accountSelectionMode`, `priority`, `failoverCutoffs`; see phase 2 for the
exact shapes and for why the order is `priority` rather than the `isPrimary` the wire shape
still shows);
per `(service, mode)` is that same setting re-keyed, not a new mechanism. Nesting the
accounts and housing the routing settings turned out to be the same fix.

An API-key card therefore has **no routing controls at all** — not a disabled group, not an
empty section, and no sentence explaining the absence. Keys do not fail over (req 12), so
there is nothing to order and nothing to spread. The asymmetry between the two card types is
req 12 rendered.

**Credential failure branches on the billing mode, not on the error — and not on how the
credential is shaped either** (req 12). The second half is easy to get wrong, because the two
look alike and this repo already holds a counter-example: `claude-env-oauth` is a
*subscription* delivered as an environment token, and GLM's coding plan is a *subscription*
authenticated by an API key. A rule keyed on "is this a key?" would refuse to fail over for
both, turning a plan outage into a stopped session. `kind` answers the billing questions; the
credential's `via` answers only where the secret comes from
([`catalogue.md`](./catalogue.md)). This is
the load-bearing simplification: ShipIt does not classify the failure, it looks at how
the failing service is authenticated — a fact it holds statically in the service row.
A subscription fails over to another subscription *of the same service*; an API key
does not fail over at all, and the turn stops.

Review confirmed this is the right axis and that the existing code already half-draws
it — but found the gate is applied in **one** of the two places that need it. Account
benching checks the route kind and bails for a reserved route
(`bootstrap-managers.ts:442`), while the same-turn quota retry has **no billing-mode gate at
all**: it fires whenever exhaustion is detected, from the error object or, when there is
none, from the turn's own text (`turn-executor.ts:1032`). A key-authenticated service
answering "quota exceeded" would therefore be retried once on the same bad key, which is
exactly what req 12 forbids. Both paths need the gate — on `kind`, never on how the credential is shaped.

That also means there is no service re-prompt flow to build; the spike proposed
one. See Appendix A for what has to be *removed* instead.

The rule generalizes rather than invents. Today `provider-account-manager.ts` already
refuses to mark a reserved API-key route exhausted ("they are metered billing, not a
subscription window", `:642`), treats reserved routes as always usable (`:720`), skips
them when stamping exhaustion (`:800`), and never routes onto pay-as-you-go **because a
subscription ran out** — an exhausted set returns `all_exhausted` rather than falling through
(`:695`). Stated more strongly than that it is false, and an earlier draft did state it more
strongly: when there is **no connected subscription at all**, the manual-auth case, the
reserved key *is* chosen (`:703`). The distinction is exactly the one req 12 preserves —
never a silent hop off a spent plan, but a key-only user still works. The work is to lift
that from
per-`AgentId` accounts to per-`(service, billing mode)` credentials, not to invent a
policy — and the existing code's reserved-key-route carve-out is that same billing-mode
distinction, drawn one level down.

**"The harness's own vendor is authenticated" is the assumption this feature has to dismantle,
and it is spread across more of the product than any one grep suggests.** Treat the list below
as a starting map, not an inventory — an earlier draft called it "six places, not one", which
was itself the over-claim it was warning about, and a missed gate does not fail loudly: it
leaves a model selectable and then refuses the turn.

Four kinds of site, all reading `AgentInfo.authConfigured` or its derivatives:

- **Availability** — `AgentRegistry.available()` (`agent-registry.ts:401`).
- **Selection** — HTTP (`services/settings.ts:323`), WS (`route-registry.ts:1164`), the
  picker's disabled state (`ModelAgentSelector.tsx:217`), the client's automatic redirect to
  an authenticated agent (`client/utils/resolve-authed-selection.ts:27`).
- **Turn admission** — `isAgentAuthenticated` (`services/agent-auth-gate.ts:22`), consulted by
  both `send-message.ts:44` and `services/agent.ts:35`. **This is the one that matters most
  and the one an inventory built from the picker misses**: get it wrong and the model is
  offered, chosen, and then the turn is rejected — req 2 failing at the last possible moment.
- **Spawning others** — sub-agents (`services/sub-agent.ts:208`) and cross-agent reviewer
  selection. Until all six change, a DeepSeek-only user is refused Claude
Code — which is req 2 failing, in the exact configuration this feature exists to serve.

The replacement is a split, not a rename, and it is what makes the six sites easy to reason
about individually:

- **A harness is *available* if it is installed.** Nothing about credentials (req 14). This is
  what `AgentRegistry.available()` and the two selection paths should ask.
- **A model is *eligible* if its `(service, billing mode)` has a credential** (req 8). This is
  what the picker and sub-agent spawning should ask, per model rather than per harness.

`authConfigured` then has no meaning to preserve and leaves `AgentInfo`. Onboarding is the one
site that is not a mechanical substitution: "no harness is authenticated" becomes "no service
has a credential", which is a different question about a different object, and it is the
condition that actually blocks a first turn.

**Eligibility** (req 8) moves from `hasAnyAuthForProvider(provider)` to a per-billing-mode
question: *does the service offering this model have a credential?* With Anthropic as an
ordinary service, "Claude with no account connected" and "DeepSeek with no key" become
the same condition answered by the same code. This retires the spike's overstatement
rather than patching it.

Note the narrow scope: eligibility is a **credential** check and nothing more. It does
not assert the model will work — that is req 1's best-effort territory — so there is no
runtime validation to build and no staleness policy to maintain. A model that stops
working at its service is a catalogue update in the next ShipIt release.

**Reasoning effort stays on the harness, and the catalogue gains no reasoning field.**
Worth stating because it looks like an oversight: `AgentCapabilities.reasoning`
(`agent-registry.ts`) is keyed per `AgentId` — Claude Code's `--effort low…max`, Codex's
`model_reasoning_effort none…xhigh`, each verified against its CLI (docs/217) — and this
feature leaves that alone even though it un-keys models from `AgentId`.

The tempting change is to declare per model whether reasoning is supported, and hide the
control when it is not. It was considered and rejected, for a reason that is easy to miss:
**the harness is not a transparent pipe for the setting.** Even a correct per-model claim
says nothing about whether the harness in use forwards it, so a harness that quietly drops
the flag would leave ShipIt asserting support that does nothing — the same dishonesty,
relocated and made to look more precise. There is also no maintainable source for the fact,
which would put per-model upkeep on the axis req 6 shrank the catalogue to avoid.

So the offered levels are the harness's, unnarrowed, and a value the model does not honour
is req 1's best-effort territory. A value the *harness* rejects is the harness's error to
raise — the authoritative answer, arriving from the component that actually knows, which is
strictly better than a ShipIt-side prediction that pre-disables the control.

**One consequence for the composer, easy to miss because reasoning is not changing:** since
the levels belong to the harness, a harness switch can strand the *effort value* just as it
can strand the model. Claude Code has `max` and Codex does not; Codex has `none` and
`minimal` and Claude Code does not. The rule is the same shape as the model's but the
fallback is different — **reset to Default rather than mapping to a neighbour**, because a
level name shared by two CLIs is not a promise of shared semantics, and Default (omit the
flag) is always valid. A value both harnesses accept survives untouched. A harness with no
reasoning block at all shows no control rather than an empty one.

That makes three things a harness switch can move — model, billing mode, effort — and the
composer has to report all of them in one message rather than the last one to be computed.

**Mid-session model switching** (req 4) is not a new mechanism: the model is already per-turn
data — a spawn flag for Claude Code, a `turn/start` field for Codex — so both shipped
harnesses support it unconditionally. Req 4's "as far as that harness supports it" is
therefore carried by **no flag today**, deliberately: a capability with one possible value is
noise, and `AgentCapabilities` gains one only if a candidate turns up that fixes its model at
process start. A switch that
crosses *services* additionally re-resolves the credential and base URL for the next spawn.

ShipIt already forces a respawn boundary for a *model* change:
`releaseResidentOnModelChange` (`resident-model-guard.ts`) kills a resident process
whose spawn-time model no longer matches the selection, and the turn respawns with the
new `--model` and `--resume <session>` (`agent-execution.ts:291`).

**But a service change does NOT ride that boundary, and an earlier draft of this doc
wrongly said it did.** The guard compares two model *strings* — `runner.appliedModel`
against the desired model (`resident-model-guard.ts:44`) — and `appliedModel` is set
from `runParams.model` alone (`turn-executor.ts:1225`). Since the same model id can be
offered by two services, switching `deepseek-v4-flash` from DeepSeek direct to
OpenRouter leaves the strings equal, no kill fires, and the next turn runs on the
**old process with the old endpoint and old credential** — silently billing the wrong
service and contradicting req 11.

So the resident process's identity must be the whole spawn-relevant tuple — harness, service,
**billing mode**, API style, endpoint, credential route, model — not a model string. Billing
mode is not optional in that list: without it a subscription and a key selection for the same
service and model collapse into one identity, and the switch req 12 exists to make possible
("charge me, keep working") would reuse the spent subscription's process. This is the picker's
own `(service, billing mode, model)` identity applied one layer down, and the two should share
a representation rather than each inventing one.

Note the correction this implies for "the model is already a per-turn spawn argument":
for a **resident** process it is not. Later turns are injected without spawning until
that guard forces a boundary, which is precisely why the guard exists.

**Credential delivery** reuses the existing pipe with **one** correction, not two: a
compile-time key name per catalogue service is sufficient (Appendix A). What
does still need building is the compose path — a compose-backed containerized session receives only
compose-declared and `mcp__*` secrets, so a stored service key never reaches it.

**A subscription mode is supported as a mechanism; each vendor's subscription is its own
integration** (req 5). What that integration *consists of* varies, and assuming it is always a
login flow is the mistake to avoid: an account-backed subscription travels through credential
roots and filesystem mounts and needs login and refresh, while a **string-delivered** one —
GLM's coding plan — is a supplied secret with no account root and no login at all, needing
multi-instance storage and a quota reader instead ([`catalogue.md`](./catalogue.md)). So the catalogue,
picker, eligibility, usage and failover are all written to handle a subscription mode on any
service, and adding a *particular* vendor's is a bounded piece of per-service work rather
than a change to any of that. Existing subscription-backed vendors keep their current path
unchanged.

**GLM is the intended validation case** (req 15's open subscription coverage). It has a
coding plan alongside an ordinary API, so it is a *custom* service that genuinely carries
both modes — which is the case Anthropic cannot test, since Anthropic's dual mode is the
pre-existing one. Note this is why the prototypes were corrected: they illustrated the split
with a DeepSeek subscription, and DeepSeek has none. As with the gateways, GLM's actual
styles, models and plan limits are research to do when the row is authored, not recalled
from this doc.

**Spawn shaping** sets the base URL and credential at both spawn sites, after the
scrub, from the *selected model's* service rather than from a model-id prefix.

**Non-turn work** (req 9) — session naming and PR descriptions run on a model the user
chooses **for that purpose**, resolved independently of whatever the session is using.

**This is the one phase whose execution path does not exist yet, and saying "no existing seam"
understated it.** The two halves are not merely un-parameterized; they are differently broken.
Session naming *does* run a model — `session-namer.ts:28` takes an `AgentId` plus a credential
root and shells out locally — so it needs the resolved triple threaded through, which is
parameter work. **PR description generation has no agent at all in production**: the
orchestrator lives outside session containers, so the default text generator returns an empty
string and the feature degrades silently (`app-di.ts:485`), and the callback that would carry
a selection has neither model nor harness (`services/github.ts:1511`). Req 9 explicitly calls
that half a *change*, not a preserved behaviour.

**A resolver only chooses; something still has to run the model — and that path already
exists.** The orchestrator has no *resident* agent, which is why the default text generator
returns `""`. But it does have a one-shot brokered spawn: `spawnSubAgent()` posts to the
worker's `/agent/spawn`, runs a fresh adapter **outside** the resident agent slot, and returns
the accumulated text over the HTTP response (`container-session-runner.ts:437`), with a local
in-process twin for `RUNTIME_MODE=local` (`session-runner.ts:1488`). It is HTTP-only, as
CLAUDE.md requires, and it is what `shipit agent run` already uses.

**It also solves the lifecycle problem for free.** An in-flight spawn is registered in
`_subAgentAborts`, and `subAgentSpawnsInFlight` feeds `agentBusy` precisely so a backgrounded
consult stays off the idle-eviction list (`container-session-runner.ts:394`). So a generation
in progress is already protected from reclamation, and `dispose` can already cancel it.

**What phase 3 must still do is expose its resolver** — selection → harness, endpoint,
credential, style — **as a callable component rather than inline spawn code**, because phase 7
is its second caller. That is a factoring constraint, invisible from phase 3's own scope, and
free if honoured up front.

Two earlier drafts of this paragraph were wrong in opposite directions: the first said the
container is alive "by construction", the second that new surface and new busy protection were
unavoidable. Neither was true. Phase 3 has to widen this same spawn path for custom-service
selections anyway, so phase 7 is only its second caller.

For a pull request created outside a turn, from a session whose container is gone, this is the
ordinary activation path: ShipIt starts a session's container for user actions, and creating a
PR is one.

Session naming is unaffected — it already runs a CLI (`session-namer.ts:28`) and only needs
the resolved triple threaded through.

**Non-turn work spends money, and nothing records it.** This phase makes both halves
user-configurable onto an arbitrary service and billing mode — which means a user can point
session naming at a metered service and be charged for every session they create, with the
spend appearing nowhere. Today naming asks for text and discards the telemetry entirely
(`session-namer.ts:73` ✅ returns a string), and the brokered spawn returns a result whose
recording happens one level up in the sub-agent service, not in the spawn itself
(`container-session-runner.ts:455` ✅). So there is no row and no column to put one in.

That collides with req 16 as *displayed*: "where the money went" and a metered-spend total read
as exhaustive. Two honest options, and this phase picks the first:

- **Record it.** Both paths already flow through the spawn that `services/sub-agent.ts` records
  against — the recording is at the wrong level, not absent. Naming and PR generation get rows
  with their own attribution, the same way a `shipit agent run` consult does. The cost is
  widening the same writer phase 3 already has to widen, plus deciding which session a
  container-less PR generation attributes to (the session whose PR it is).
- **Scope the label.** Leave it unrecorded and the usage view says it covers agent turns only.

Recording wins because the alternative writes an asterisk onto the headline number req 16
exists to make trustworthy, and because the gap grows exactly as this feature succeeds — the
more services a user configures, the more non-turn spend escapes the total. The second option
stays written down because it is what should happen if the attribution question turns out
harder than it looks: an honest narrower claim beats a broad one with a footnote.
It is a `(service, billing mode, model)` selection like any other, not a service alone: a
service does not identify something callable, and the mode is what says whether the work is
metered. It surfaces as its own setting, and it has a default so the feature works
unconfigured — the setting being *visible* is what stops that default from re-creating the
hidden dependency this requirement exists to remove.

**The harness is derived, not chosen** (req 9). Running a model means spawning a CLI, and
a model can be offered on more than one installed harness — so something has to pick. It is
not a second control: the setting stays a model choice like any other (req 3), and non-turn
work takes the **first installed harness that model is offered on**, in the same catalogue
ordering the picker uses. The rule is arbitrary and that is acceptable here in a way it
would not be in a session: the work is a session title and a PR description, the harnesses
that can run a given model all run it, and req 9's notice already covers the failure. A
user who cares which harness writes their PR descriptions is not a case this design serves,
and inventing a control for them would be a worse trade than picking one.

**The default is a rule, not a stored value** (req 9): unset means *the first eligible
model in the picker's own ordering* — first service, first billing mode, first model —
resolved at the point non-turn work runs, not frozen at install. Eligible is the same
conjunction the picker uses: an installed harness (req 14) whose service has a credential
for that mode (req 8). So the setting
has two states, and they are not the same thing: **unset** follows the install, and **set**
is a pin the user chose and ShipIt does not move. Only the second can go stale, and it is
the one req 9's notice reports on.

A consequence worth accepting rather than designing around: the picker orders by
capability, so the derived default is likely to be a *large* model doing work — session
titles, PR descriptions — that a small one does fine. Nothing here says otherwise, and
cheapness is not a requirement. If it turns out to matter, the fix is the catalogue's
ordering, not a new "suitable for background work" concept.

The two halves are not symmetric, and only one of them preserves today's behavior:

- *Session naming's **failure** behaviour already matches; its **selection** does not.*
  `generateSessionName` returns `null` on any failure and is documented as silent best-effort
  (`session-namer.ts:19`); graduation installs a placeholder first
  (`graduate-session.ts:158`) and keeps it when naming returns `null`
  (`graduate-session.ts:311`) — so on that half only the notice is new. But the call takes
  `(userText, agentId, credentialRoot)` and passes no model at all
  (`services/graduate-session.ts:243`), so it cannot express req 9's independently chosen
  `(service, billing mode, model)`. An earlier draft said naming "already behaves as
  required", which was true of the fallback and false of the requirement.
- *PR descriptions do not.* `generatePrDescriptionFromContext` returns whatever
  `generateText` returns (`services/github.ts:1412`), and in containerized production
  that is the empty string (`app-di.ts:485`) — the generic prose lives only in the
  `catch`, so it is reached on a thrown error and not on a blank result. Satisfying
  req 9 therefore means **normalizing a blank generation into the generic fallback**,
  with separate tests for the rejection path and the blank-success path.

**The notice has to be durable, not a toast.** Session naming is fire-and-forget: it can
finish while the user is looking at another session or with no viewer attached at all, so
a transient toast would be silent in exactly the case req 9 exists to prevent. It should
be transcript content, which brings it under ShipIt's persistence and session-scoping
rules — persisted via `emitChatCard`, carrying its owning `sessionId`, registered in
`TRANSCRIPT_SCOPED_MESSAGES` (see `docs/188`, `docs/191`). Dismissal is state on that
row, not the absence of one. Deliberately not "follow the session's model": the failure this
requirement comes from was a credential disappearing underneath work that assumed it
(a lapsed Claude subscription while working in Codex), and inheriting the session's
model would leave that same implicit dependency in place, merely pointed elsewhere. An
explicit setting is also the only version that can be *shown* to the user as broken
when its service stops working. This is the one place with no existing seam at all, and
the largest single piece of work here.

**Retiring a catalogue entry** (req 13). Curation means removal is routine, so the catalogue
records each retired model alongside the styles it was declared under and a successor per
style. A session pinned to a retired model resolves through that record at the point the model
is read, and runs on the successor; the picker offers only current models.

The record lives **inside a `(service, billing mode)`** — it crosses neither — and the
successor must additionally be runnable on the session's harness.
All three are requirements (req 13) and all three are load-bearing. Because
`serviceId` is unchanged, the credential, the endpoint and the provider are unchanged, so
a remap cannot strand a session on a service the user has no credential for. Because the
**mode** is unchanged, *whether* the turn is billed is unchanged — the successor is declared
under the same mode, so a session running included work cannot be remapped onto metered
work. That second half is why the map is keyed per mode rather than per service: a service
declares its models *per mode* (req 6), so a per-service map would have no way to say that
the subscription's successor and the key's successor differ, or that the subscription has
none at all.

**The harness is the third axis, and a bare id→id map cannot carry it** (req 13). A model's
availability depends on the API style too, so a successor declared only under a style the
session's pinned harness does not speak strands the session exactly as a missing successor
would. Two things follow, and the second is the one that is easy to miss:

1. A `(service, mode): old → new` map cannot express a retirement whose successor **differs
   by style**.
2. It cannot even *check* the constraint. The obvious fix — "fail the catalogue check unless
   the successor is declared under at least the styles the retired model was" — is
   unenforceable, because by then the retired model is gone from `models` and its styles went
   with it. There is nothing left to compare against.

So the retirement record must **carry the retired model's styles itself**, alongside a
successor per style. That is `RetiredModel` in [`catalogue.md`](./catalogue.md), and the
invariant becomes checkable from the row alone at authoring time. The runtime behaviour req
13 specifies is unchanged; what changed is that one of the two candidate shapes turned out
not to work.

**What preserving the mode does not buy is an unchanged rate.** Two models under one
service's key are priced differently, so a metered session's turns can get cheaper or dearer
across a remap. Preserving the mode prevents *included* work from becoming *billed* work,
which is the discontinuity worth preventing; it says nothing about the number. Two earlier
drafts of this paragraph got this wrong in opposite directions — the first argued a
per-*service* map was safe because "the price is unchanged", which billing modes made false;
the second kept the claim while fixing the key, which is still false for a different reason.

A mode that retires a model with no successor to offer is a **catalogue mistake**, not a
runtime case: there is no fallback to the other mode, because that is the silent shift onto
metered billing req 12 exists to refuse. Two services retiring the same model id toward
different successors is still handled — each states its own successor in its own row, and
now each mode does too.

There is precedent to copy rather than a mechanism to invent: `normalizeCodexModelId`
(`agent-registry.ts:141`) already does exactly this for one model, mapping the retired
`gpt-5.6` slug onto `gpt-5.6-sol` "at the boundary before Codex turns so legacy sessions
run the intended Sol model". Req 13 generalizes that one-off shim from a hardcoded
per-`AgentId` special case into a per-service catalogue field resolved at the same
boundary.

**The remap writes through to the session's stored selection; it is not a read-time
normalization.** The precedent this generalizes, `normalizeCodexModelId`, rewrites the model
only at the turn boundary (`agent-registry.ts:136`) and leaves the persisted row alone — and
the picker deliberately gives the *persisted* model precedence over the live one the CLI
reports (`ModelAgentSelector.tsx:121`). Transcribing the shim's shape would therefore run the
successor while continuing to display the retired id, which is exactly the invisible remap
reqs 11 and 13 forbid. Resolving through the record and persisting the result makes the
picker and attribution agree with what is running, without a second precedence rule.

**Usage** (req 10) is reported per **billing mode of a service** — but the *credential route*
stays in the key, and dropping it would be a regression, not a simplification. Today's shape
is `AgentId → routeId → limits` (`usage-limits-types.ts:36`), and the inner key is
load-bearing: two connected subscriptions have two independent 5h windows, two independent
`/api/oauth/usage` results and two independent 429 lockouts, and the limits provider's own
comment says sharing any of them is the overwrite-and-flicker bug it exists to avoid
(`claude/limits-provider.ts:85`). Req 12 needs it too — failover has to know *which*
subscription is exhausted before moving to another.

So the target shape is **`(service, billing mode) → routeId → limits`**: the outer key moves,
the inner one does not. What changes is `LimitsProvider`/`LimitsRegistry` being selected by
`AgentId` first (`agents/types.ts:22`, `limits-registry.ts:39`); the per-route granularity
underneath is preserved as-is.

Note this is two distinct things, and only the first is at issue: **quota telemetry**
(`SubscriptionLimits` — plan tier, rolling and weekly windows, `usedPct`, `resetAt`,
fed by `rate_limit_event` or `/api/oauth/usage`) versus **token and cost accounting**
(`RecordedTurn` — `costUsd`, input/output tokens, cache reads, context occupancy),
which ShipIt already records per turn for every provider. A key-based service has no
quota to report but full token accounting. Req 10 keeps that slot **empty** for such a
service, which is what a key-based route already does today — so this is inherited
behavior to preserve, not new behavior to build. Putting spend in that slot is
deliberately out of scope; the data exists, but it is its own feature.

**Cost is reported per service × billing mode, and a single total stops being honest**
([prototype](./mockup-usage.html)). `UsageModal` shows one **Cost** stat today
(`currentSessionUsage.totalCostUsd`), which is correct while a session has one provider and
one way of paying. Once a session can move between a subscription and a metered key — even
within one service — that total silently adds *money spent* to *tokens already paid for*.

The split is the same axis as everywhere else, and the two **GLM** rows in the prototype are
why it has to be the **mode** and not the service: one service, two lines — its coding plan
and its API key — and merging them would attach a price to a row that is mostly free.

Two headline numbers rather than one, because dollars and quota do not sum: **"Metered spend
(est.)"** totals the metered rows only — the one figure that is money — and plan usage is
counted in turns beside it. A session with no metered rows says **"Nothing"**, not `$0.00`; a
zero reads as telemetry that came back empty, which is the wrong impression for what is the
normal case for a subscription user.

**"est." is load-bearing, not hedging.** The figure is computed from the catalogue's four
rates, which cannot express per-request, image or tiered-cache charges
([`catalogue.md`](./catalogue.md)), so calling it "You paid" would assert a fact about a bank
statement — the same class of error as trusting `costUsd`, which is what motivated the price
table in the first place.

**Plan usage carries its API-rate value too** — "≈ $243.60 at API rates". That is the number
that says whether a subscription is worth keeping. Withholding it to protect the
paid/included distinction is overcautious: that distinction is carried by colour, wording and
position, not by the absence of a second figure. It is not the paid
colour, it sits below the volume rather than in the amount slot, it is prefixed `≈` and
suffixed "at API rates", and it is **never** summed into "You paid", which stays the only
figure that is money.

**The weekly chart stays a toggle and does not stack.** `UsageModal` already toggles cost vs
turns; this adds a third option (Paid / At API rates / Tokens) rather than stacking a second
series on the first. Two segments in one bar carrying two different units invites reading
them as parts of a whole, which they are not. The split still tells its story across the
toggle — weeks where Paid rises are weeks where At API rates falls, meaning work moved *off*
the plans rather than that there was more of it, which Tokens confirms.

**Volume is tokens throughout, not turns** (req 16). The existing view counts turns, so this
is a change to an inherited surface rather than a choice about a new one: the volume column,
the plan headline and the chart's third series all move to tokens, and the existing cost-vs-turns
toggle becomes cost-vs-tokens. Turn counts stay where they describe a *session* rather than
measure consumption — the header's "31 turns · 1h 12m" is session metadata and keeps its
meaning. `RecordedTurn` already stores the token counts this needs (`usage.ts:28`), so nothing
new is recorded; only the aggregation and the labels change.

**What the dogfood data actually shows, which is less than two earlier drafts claimed.** The
spike's turns are in `.inner-shipit/.shipit.db` (`usage_turns`): four rows on
`deepseek-v4-flash`, run through Claude Code against a DeepSeek **API key** — two full turns
at `$0.346747` and `$0.694466`, one `$0.028413` which is a *delta* against a cumulative of
`$0.375160` (corroborating the cumulative-to-delta behaviour rather than being a third data
point), and one `$0`.

**That is not enough to prove whose price table produced the figures, and this document no
longer claims it is.** Two earlier attempts both overreached: the first reported a "constant
18×" against DeepSeek's rates, which the database cannot support because it holds no vendor
rate and no invoice; the second replaced it with "an exact linear fit across differing shapes",
which is worse — two observations against three unknown rates (input, output, cache-read) fit
exactly by construction, so the fit is arithmetic rather than evidence. Vendor billing is
itself linear in tokens, so even a genuine fit would not distinguish the two hypotheses.

**The design does not need that proof.** Req 16 requires a price table on its own terms, from
facts that are not in doubt: the "at API rates" comparison for a *subscription* turn cannot
come from a CLI that reports nothing meaningful when no money moved, and Codex reports no
dollar figure at all. Those alone put a `(service, mode, model)` table in phase 1. What
remains genuinely open is narrower — what a first-party `total_cost_usd` means on a
subscription turn — and it is recorded as such rather than dressed up as a measurement.

What follows does **not** depend on identifying whose table produced the figure. Three
consequences, each from something not in doubt:

- **Metered spend cannot come from `costUsd`** for a service the CLI was redirected to: the
  figure is produced by a CLI that was never told which vendor it is talking to, so whatever
  it means, it is not that vendor's price.
- **"At API rates" cannot come from it at all**, for a stronger reason that needs no
  measurement: on a subscription turn no money moved, so there is no figure to reinterpret.
- Therefore **ShipIt needs its own price table keyed by `(service, billing mode, model)`** to compute either
  figure honestly — which puts per-model pricing into the catalogue, the axis req 6 has
  deliberately kept small. That is a real cost of the usage screen and it should be counted
  against it, not discovered in phase 6.

The narrower original question — what the figure means for a *subscription* turn on the
harness's own vendor — was carried as open for several rounds and is now **closed by the rule's
shape rather than by an answer**: under [`catalogue.md`](./catalogue.md)'s billing-mode keying,
a subscription row never sources its figure from the harness, so what that figure would have
meant no longer needs establishing. It was the exception being keyed on the wrong axis, not a
narrow gap. The dogfood data could not have answered it either, since every recorded turn there
is key-authenticated.

**The known-wrong behaviors** resolve unevenly:

- The **empty usage pill** is not a bug at all once the indicator is per-service — a
  service with no quota should show nothing (req 10).
- The **non-turn failures** are covered by req 9, though as two separate paths rather
  than one.
- The **401 misfire** is fixed by *deleting* behavior, not adding it (req 12). Today
  `AUTH_ERROR_PATTERNS` (`process.ts:43`) catches auth-shaped text and drives ShipIt's
  own re-auth flow, which for an API-keyed service is both wrong and unfixable. That
  interception must not apply to a key-authenticated service; the turn stops and says
  so.

  Note what this does *not* require: ShipIt never has to decide whether a given error
  means "quota spent" or "key is bad". The branch is on the billing mode, which is
  known before the turn starts — and it has to be, because the error cannot carry it:
  Claude's matching output is reduced to a payload-free `auth_required` event
  (`process.ts:173`), so the orchestrator already recovers the route separately
  (`turn-executor.ts:365`).

  An earlier draft said subscription failover and account recovery "stay exactly as they
  are". That overstates today's coverage in two ways, both of which are work: the quota
  retry is not route-gated (above), and this analysis covers only Claude's
  `AUTH_ERROR_PATTERNS`. Codex classifies separately (`codex/adapter.ts:324`), and a
  Codex `turn/start` quota failure can arrive as a rejected JSON-RPC request
  (`codex/adapter.ts:723`) that becomes an adapter `error` rather than the
  `agent_result` the quota retry watches. Per-harness coverage has to be established,
  not assumed.

## Key files

| File | Why it matters |
|---|---|
| `shared/agent-registry.ts` | `AGENT_DEFS`, `CLAUDE_MODELS`, `ALLOWED_ENV_KEYS`, `isAllowedAgentEnvKey` |
| `shared/types/agent-types.ts` | `AgentId` — the conflation lives here |
| `session/agents/claude/process.ts` | Both spawn sites, the scrub, `AUTH_ERROR_PATTERNS` |
| `orchestrator/provider-account-manager.ts` | `reservedRouteFor`, `hasAnyAuthForProvider` — route eligibility |
| `orchestrator/session-agent-env.ts` | `selectAgentEnvForPush` — credential delivery to a container |
| `orchestrator/local-agent-home.ts` | `resolveLocalAgentHome` — why reserved routes are unscoped |
| `shared/model-windows.ts` | First-frame context window |
| `client/components/ModelAgentSelector.tsx` | Picker, `METERED_MODELS` — the hand-kept metered set that billing modes delete ([`catalogue.md`](./catalogue.md)) |
| `shared/types/usage-limits-types.ts` | `SubscriptionLimits` — already keyed by `routeId` |
| `orchestrator/agents/*/limits-provider.ts` | Per-`AgentId` today; becomes per service (req 10) |
| `orchestrator/usage.ts` | `RecordedTurn` — token/cost accounting, distinct from quota |
| `orchestrator/session-namer.ts` | Non-turn spawn with no service seam (req 9) |

## Appendix A — findings from the spike

**Scope of the claim:** everything here about *ShipIt's own code* was verified against this
branch. The subsection on external providers below is **not** in that category — it is vendor
research from the spike, it cannot be checked from this repository, and `catalogue.md` marks
the same facts 🔍. An earlier version of this line claimed the whole appendix was verified.

### The credential pipe exists, but does not reach every session

`CredentialStore.agentEnv` → `selectAgentEnvForPush` (`session-agent-env.ts:217`) →
`PUT /secrets` on the worker → worker `process.env` → `spawnEnv = {...process.env}`,
gated by `isAllowedAgentEnvKey` (`agent-registry.ts:314`).

**Two corrections found by review, both load-bearing:**

1. That path only applies to a **compose-less** session. When the runner has a
   `ServiceManager`, `selectAgentEnvForPush` returns the ServiceManager snapshot
   instead, which merges compose-declared secrets with MCP secrets — and
   `collectMcpAgentEnv` filters to keys starting with `mcp__` (`secret-resolver.ts:308`).
   An ordinary top-level key stored in Settings therefore **does not** reach a
   containerized session that has a compose stack. Any design that relies on this pipe
   has to extend it, not merely add a key name.

2. `ALLOWED_ENV_KEYS` is a **compile-time constant** (`agent-registry.ts:303`), so one
   key name per service means one code change per service.

   This *used* to contradict req 7, when req 7 promised that trying a new service
   needed no release. It no longer does: the catalogue ships with ShipIt, so a new
   service is already a ShipIt change, and adding its key name in the same change costs
   nothing extra. **The requirement that justified building a runtime credential
   mechanism has disappeared, so the mechanism should not survive it** — a compile-time
   key name per catalogue service is now the simpler and sufficient answer.

The compose gap in (1) is unaffected and still has to be closed, on its own merits
rather than as a consequence of req 7.

### The credential-scrub only applies to local mode

`scrubEnvAuthForScopedHome` (`process.ts:28`) deletes `ANTHROPIC_API_KEY` and
`ANTHROPIC_AUTH_TOKEN`, but only when a **scoped home** is set. `session-worker.ts:742`
constructs `new ClaudeProcess()` with no resolver, so containerized sessions are never
scrubbed; only the local-mode factory (`app-di.ts:574`) passes one. And
`resolveLocalAgentHome` (`local-agent-home.ts:82`) returns `undefined` for the reserved
env routes anyway.

Consequence: **ShipIt's storage name for a custom credential must not be an Anthropic
variable name**, or the route works or fails depending on how the install happens to be
signed in — a difference unrelated to the feature. `DEEPSEEK_API_KEY` is the storage name for
that reason.

That is not the same as saying the *child process* sees `DEEPSEEK_API_KEY`, and an earlier
draft of this paragraph concluded exactly that ("sidesteps it entirely"). It does not: Claude
Code reads its own variables and nothing else, so a custom service's value has to be written
into one of them at spawn time, after the scrub. Storage name and spawn target are two
different things, and the design keeps them apart deliberately
([`catalogue.md`](./catalogue.md)).

### There are two spawn sites, not one

`ClaudeProcess.run` (PTY) and `StreamingClaudeProcess.run` both build a spawn env.
**Streaming is the default whenever live steering is on**, so anything wired into only
the PTY path unit-tests green and does nothing in a real session. Confirmed in the
dogfood run: the log line was `[streaming-claude] spawning:`.

Any env-shaping for custom models must be applied at both, and **after** the scrub —
ordering is load-bearing, and is pinned by a test.

*(A vendor-research subsection stood here — which services speak which API styles. It was
duplicated by [`catalogue.md`](./catalogue.md)'s 🔍 rows and phase-1 checklist, which is the
designated home for claims this repository cannot verify, so it lives there only.)*

### Two things break — and a third that only looked broken

1. **A 401 triggers the wrong recovery.** `AUTH_ERROR_PATTERNS` (`process.ts:43`)
   matches `"unauthorized"` / `"authentication_error"`, so a bad custom key kicks the
   session into the *harness vendor's* OAuth re-auth flow, which cannot fix it.
2. **Non-turn CLI spawns fail — but the two are not the same path.** Corrected on
   review: session naming *does* have a credential seam, selecting the route a turn
   would use and passing that account's credential root
   (`graduate-session.ts:250`, `session-namer.ts:28`); it is implicit and agent-bound,
   not absent. What it lacks is an *explicit, user-selected* model (req 9). PR
   descriptions go through `generateText`, which in containerized production has no
   in-process factory and returns an empty string rather than spawning at all
   (`app-di.ts:485`) — so it degrades silently instead of failing.
   The observed `[session-namer] claude CLI failed` was the *local-mode* path, where a
   reserved route resolves no account root. These are two designs, not one.

Both are code that assumes a service identity the type system cannot express — the
same gap as above, surfacing twice. Neither should be patched individually.

The third symptom, an **empty usage pill** (`ClaudeLimitsProvider` is event-fed from
`agent_rate_limits`, which a non-Anthropic service does not emit), was originally
recorded here as a bug. It is not one: once the indicator is per-service, a service
with no quota *should* show nothing (req 10). Kept in this list because the mistake is
easy to repeat — the correct behavior is indistinguishable from the bug by inspection.

### Prompt caching is not portable

`PRECOMPUTED_INSTRUCTIONS` renders every prompt variant once at module load
specifically to keep the CLI string byte-stable for Anthropic's prompt cache. Another
service has its own cache semantics, so cost and latency on its models are not
comparable to the tuned path, in either direction.

## Appendix B — the spike, and what it proved

An experimental spike ran before this document, to answer "does this work at all", and was
removed from the branch on 2026-08-05 once it had. **It established that the approach works**:
a full session ran on DeepSeek V4 Flash through the unmodified Claude Code harness — multi-step
tool use, correct output, a second dispatched turn — with `providerRouteId: claude-api-key` and
no backend changes. That is the feasibility evidence behind req 1, and it is why this design
treats the harness as untouched.

It was never an implementation of these requirements: it hardcoded one model id and one
endpoint, and made `hasAnyAuthForProvider`/`reservedRouteFor` treat a DeepSeek key as a
Claude-provider route — an overstatement req 8 now rules out. Its findings about *ShipIt's*
code are in Appendix A; the code itself is recoverable from this branch's history.
