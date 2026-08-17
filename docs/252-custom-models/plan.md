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
motivating case is DeepSeek, which appeared to speak both styles while supporting only
`deepseek-v4-flash` under Codex (🔍 — [`catalogue.md`](./catalogue.md) carried this as
research, not as a finding; *confirmed 2026-08-13, both models — see the dated correction
to phase 3's survey*), and Codex additionally wants per-model metadata — a context
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
| 3 | Spawn shaping and eligibility | 1, 2, 3, 8, 11, 16 | **A session runs on a custom service.** Turns record what billed them, and respawn on a service change. **Landed.** |
| 4 | In-session switching | 4 | The picker acts mid-session, across services. **Landed.** |
| 5 | Credential-failure policy | 12 | Correct behaviour when a credential dies. **Landed.** |
| 6 | Usage, cost and attribution | 10, 11, 16 | You can *see* what you are running and where the money went. (Phase 3 records it.) **Landed.** |
| 7 | Non-turn work | 9 | Naming and PR descriptions get their own model. **Landed.** |
| 8 | Model retirement | 13 | Sessions survive a model leaving the catalogue. |
| 9 | Harness install selection | 14 | Deployments choose their harnesses. **Landed.** |

**Phase 1 — Catalogue and identities.** The service catalogue as data: `serviceId`, the
API styles each service speaks, per style the models declared for it plus the metadata
that style needs, and a per-style endpoint. `AgentId` gains a declared **set** of API styles and stops
meaning anything else. The selected model becomes the triple
`(serviceId, billingMode, modelId)` throughout — types, persistence, and the picker's
plumbing — with each billing mode declaring its own models per style. Anthropic and OpenAI
become ordinary catalogue rows, each already carrying both modes.

**Phase 1 has landed.** The rows live in `src/server/shared/catalogue/`
(`types.ts`, `harnesses.ts`, `services.ts`, `index.ts`), with the invariants
`catalogue.md` says the type system cannot carry enforced by
`catalogue/catalogue.test.ts`. Every `PRICE_TODO` and `CONTEXT_TODO` sentinel is
replaced with a figure read from the vendor's own documentation on 2026-08-09;
the source per vendor, and the derivation for the two whose cache rates are
published as multipliers rather than rates, are in `services.ts`'s header
comment. What authoring the rows *found* is below, after the phase list.

**Catalogue maintenance (2026-08-17): GPT-5.3-Codex-Spark.** Spark is an
OpenAI subscription-only research preview: it is available to ChatGPT Pro in
the Codex CLI and IDE extension, but OpenAI marks API access unavailable. It is
therefore declared only under `openai:sub`. OpenAI publishes no Spark API rate,
so its catalogue row follows the GLM-5.3 precedent and carries GPT-5.3-Codex's
published rate as an explicitly documented provisional estimate. The row keeps
Codex's existing 272K first-frame fallback; runtime telemetry remains
authoritative after a turn starts.

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

**What phase 1 found while authoring the rows.** Five things the design did not
anticipate, recorded here because three of them change what a later phase has to build.

- **A model's id can differ by API style, and `ModelDef` cannot say so.** GLM's coding
  plan calls the same model `glm-5.2[1m]` on its Anthropic-protocol path — the bracket
  suffix is what selects the full 1M window — and `glm-5.2` on its OpenAI-protocol one.
  `ModelDef` has one `id` and a *set* of `styles`, so the pair cannot both be declared.
  Phase 1 declares GLM's subscription under the Anthropic style only, which is the path
  ShipIt would actually drive, rather than inventing a per-style id map in a phase that
  ships no behaviour. **Phase 2 owns the decision** when it builds the GLM integration:
  either `ModelDef.id` becomes `string | Partial<Record<ApiStyle, string>>`, or the row
  splits into one model per style. This is the same shape of problem as OpenCode's
  `provider/model` namespace, which `catalogue.md` also leaves open — worth solving once.
- **`claude-fable-5` belongs to both billing modes, and `METERED_MODELS` is now stale
  rather than load-bearing.** `catalogue.md` left this as checklist item 4, with the two
  branches spelled out: if Fable is genuinely unavailable under an Anthropic subscription it
  becomes req 5's worked example and the hand-kept `METERED_MODELS` set deletes; if not, it
  belongs to both modes at their own rates. Phase 1 confirmed the second — Anthropic
  publishes Fable on the ordinary API and a subscription reaches it — so it is declared under
  both modes and the picker offers exactly what it offered before.

  What the check *also* found is that `METERED_MODELS`' own comment ("bills per token
  (usage-based) rather than against the subscription plan limit") no longer describes Fable:
  it counts against the plan like any other subscription model (confirmed 2026-08-09). That
  briefly looked like a third case `BillingMode` could not express — a plan-reachable model
  that still costs money — and was raised as an open question against req 16. It is not one;
  the premise was a stale comment, and the receipt in `requirements.md` records the closure.

  **The `$` icon it drives is therefore telling users something untrue, and removing it is a
  user-visible change phase 1 forbids.** It was left exactly as it was there and deleted in
  **phase 3**, with the rest of `ModelAgentSelector`, where rebuilding the picker made removing
  a hand-kept per-model set a deletion rather than a behaviour change.
- **`capabilities.models` is derived from the harness's `nativeService`, not from the
  join.** The join would put DeepSeek and the gateways in the picker immediately, with no
  way to give them a credential (phase 2) or route a turn to them (phase 3) — a
  user-visible change, which phase 1's review criterion forbids. `nativeModelIdsForHarness`
  was the temporary narrowing and **phase 3 deleted it**: `catalogueModelIdsForHarness` is the
  whole join (what the harness *could* speak to), and the credential-filtered subset is
  `eligibleEntriesForHarness`, computed per install.
- **OpenRouter reaches both harnesses, and the second one arrived as a row edit.** Its
  Anthropic-Messages surface was documented from the start; whether it served the Responses
  API was open, so for a time no OpenRouter row declared `openai-responses` and the service
  reached Claude Code only. Verified 2026-08-15 (planning#391): it does serve Responses, and
  turning that into reach was adding an endpoint and a style to two model rows — no design
  change, which is the service abstraction working. The style sits on the **DeepSeek rows
  only**; the per-row reasoning is in `catalogue/services.ts` above the model list. Vercel
  documents both styles, so its rows reach both harnesses.
- **Appending a migration broke an unrelated migration test**, because that test rewound
  `user_version` by counting back from the tip. `COLOR_BACKFILL_MIGRATION` is now exported
  and the test addresses its step by index; the new migration guards its `ADD COLUMN`s so
  re-running it after such a rewind is a no-op. Production was never at risk (migrations
  run in one transaction) — but any future appended migration inherits the same
  requirement, so it is written down rather than left to be rediscovered.

**One invariant governs all three persisted selections, and cross-backend review is what
found it.** Codex's review of this branch established that the first cut broke it in four
places, each individually plausible:

> **A stored selection either names a real catalogue row, or carries no service and mode
> at all.** There is no third state.

A triple that names nothing is worse than an absent one: `resolveEndpoint` cannot shape a
turn from it, `selectionExists` reports false, and phase 3's eligibility filter has nothing
to match — so the failure surfaces two phases away from the write that caused it. The four
places, all now closed and each with a test that names the invariant: the **migration**
placed a row by its agent's vendor without checking that vendor offers the model (so a
`sonnet` alias became `anthropic:sub:sonnet`); `setModel` **kept** the previous service and
mode when handed an id it could not place; the browser slot **returned and stored**
syntactically-valid triples without checking existence; and **Quick Capture** dropped the
service and mode on the floor, re-resolving the bare id server-side to whichever service
sorts first.

**A route's billing mode is a property of the route, not of the selection in force when it
was pinned** — also from that review. `setProviderRoute` first stamped the session's
selection, which is wrong whenever the two disagree, and they can: route selection does not
consult the billing mode until phase 3, so a session selecting `sub` still lands on
`claude-api-key` when no subscription account is connected. Stamping the selection recorded
a metered key route as subscription-owned — a falsehood phases 5 and 6 read back.
`billingModeForRoute` (`sessions.ts`) now derives it from the route, by the same rule the
migration applies to historical rows. The duplication between the two is deliberate and
noted at both sites: a migration must keep reproducing the same result forever, so it cannot
follow a runtime helper.

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

**Phase 2 has landed.** `CredentialRoute`
(`shared/types/domain-types/credential-route.ts`) is the storage shape;
`credential-store.ts` holds the routes and a per-instance `credentialSecrets`
map; `services/credential-routes.ts` is the CRUD with the catalogue's rules;
`ServicesPanel.tsx` is the add-flow. GLM's coding plan can be stored, delivered
and removed like any other string-delivered subscription.

Its quota reader — the one piece phase 2 left open, because it needed phase 6's
per-`(service, mode)` machinery to have somewhere to report into — is
[GLM's quota reader](#glms-quota-reader-planning339) below. Req 15 is met on
catalogue contents and credentials; on GLM's quota it is met in code and
awaiting verification against a real coding-plan key.

**What phase 2 found.** Five things, three of which change what a later phase
does.

- **`CredentialRoute` did not have to replace `ProviderAccount` at ~70 call
  sites to replace it in storage.** The store holds routes; `listProviderAccounts`
  / `upsertProviderAccount` are a lossless projection over them
  (`providerAccountToRoute` and its inverse), because an account row *is* a
  `via: "account"` credential of its vendor's subscription mode and `provider`
  is recoverable from `serviceId` through the catalogue's `nativeService`. Phase 2
  expected **phase 3** to delete the projection once eligibility and turn routing
  stopped asking "which vendor's agent is this?"; phase 3 re-keyed what it read
  and left the router built on the projection, so the deletion became its own
  change — see [Retiring the `ProviderAccount` projection](#retiring-the-provideraccount-projection-planning342)
  below. The judgement itself held: nothing about routing changed in a
  credentials PR.
- **There were three writers for one API key, not one, and the third was
  invisible.** `setApiKey` (Anthropic) wrote only `process.env`; `set_agent_env`
  (Codex's `OPENAI_API_KEY`) wrote `CredentialData.agentEnv`; the new surface
  writes routes. Both legacy writers now go through
  `upsertSingleStringCredential`, and a load-time migration moves any catalogue
  `storageEnv` name out of `agentEnv` — moved, not copied, because a copy keeps
  being delivered from the old slot after the user removes the credential. The
  asymmetry the phase description names is closed in that direction: Anthropic's
  key now persists.
- **`process.env` is still load-bearing, and keeping it seeded is not enough —
  it has to be kept in *step*.** `reservedRouteFor` and
  `AgentRegistry.isAuthConfigured` probe the environment, so a key living only
  in the route store would persist correctly and report the provider as
  unauthenticated. `app-di` seeds it from the stored routes at boot. The half
  that is easy to miss is the other direction: without a matching *clear*,
  removing a credential stops delivering it to every session and leaves the
  orchestrator still counting it as authentication until a restart — a revoked
  credential that still authenticates. Every credential mutation now syncs the
  mode's variable, and only ever touches a value this process put there, so a
  deployment-set variable survives. **Phase 3 should retire the whole coupling
  rather than inherit it** — those probes are exactly the per-`AgentId`
  eligibility it replaces.
- **The compose gap needed a wider pipe *and* a propagation step.**
  `collectAccountAgentEnv` (MCP secrets + service credentials) replaces the
  `mcp__*`-only loader on both delivery paths, which is the gap Appendix A
  recorded. That alone only reaches the *next* sync, so every credential write
  also calls `refreshAgentEnvForAllSessions` and pushes to compose-less runners
  — the same two steps an MCP secret write already took, lifted out of
  `api-routes-mcp.ts` now that they have a second caller.
- **Delivery takes each mode's FIRST credential, and that is a placeholder.**
  A subscription can now hold several, but choosing between them is a per-turn
  routing decision phase 3 owns; phase 2 delivers what the old single slot would
  have delivered so this phase cannot change which credential a turn
  authenticates with. **Phase 3 replaces `collectServiceCredentialEnv`'s
  first-in-order rule with resolution from the selected model's service** — until
  it does, req 12's second GLM key is stored and unreachable.

**What the cross-backend review changed, recorded because four of the five are
the same mistake.** Codex reviewed the branch under CLAUDE.md's rule; the
findings below all held up on checking. Four of them are one shape: *a credential
write updated some of the places that answer "is this credential live" and not
the others*, and each one is individually plausible.

- **`process.env` was written unconditionally, which destroyed a
  deployment-supplied value.** Boot seeding deliberately skips a name that is
  already set, so a deployment's variable is not ShipIt's to overwrite — and the
  matching clear then deleted it, leaving the deployment unauthenticated until a
  restart. The rule is now "only ever touch a value this process put there",
  which costs nothing: these probes ask whether a credential is *present*, never
  which one, and which credential a session receives comes from the route store.
- **`AgentRegistry.authConfigured` is a cache, and the route endpoints did not
  refresh it.** Adding a key stored it, delivered it, and left the agent
  un-selectable; removing one left it selectable. Every credential write now
  refreshes and re-broadcasts.
- **`set_agent_env` wrote a credential and skipped the propagation.** It routes
  into the credential store now, so it owes the same push — without it a key
  saved from the Codex tab or from onboarding left a running compose-backed
  session on its previous snapshot.
- **A compose snapshot is only as fresh as the last *successful* sync**, and
  that pass returns early on an unparsable compose file — so revoking a
  credential on a session with broken YAML re-pushed the stale snapshot and the
  worker kept the revoked key. Every push now drops catalogue credential names
  the store no longer holds and the compose file does not declare, so revocation
  never depends on the user's YAML being valid.
- **The route and its secret were two writes**, leaving a window where a `ready`
  route has no secret behind it — a credential that reports configured and
  delivers nothing. One `save()` removes the window.
- **The add-flow was a dead end for an account-backed subscription**: it told the
  user to press "Add account on its card" while no card existed, because a card
  only appeared once an account did. It was first fixed by *revealing* the card
  and handing off to it — see req 17 below, which removed both the hand-off and
  the reveal. The same fix exposed a second error — a mode's two delivery shapes
  are *independent*, and Anthropic's subscription accepts both, so the dialog
  offers a token input and a sign-in rather than choosing one.

**Two findings are deferred rather than fixed, and both should be said out loud:**

- **A string-backed subscription has no routing controls.** `zai:sub` carries
  cutoffs and a selection mode in the settings payload with nowhere to set them:
  those controls live inside `ProviderAccountsCard`, keyed by provider. What
  *is* exposed is the fallback **order**, because in phase 2 that is not
  cosmetic — the first credential of a group is the delivered one, so moving a
  row changes which key a session receives. The rest do nothing until **phase 5**
  makes failover real for a string-backed subscription, which is where they
  belong.
- **Rollback and re-upgrade is lossy.** The frozen `providerAccounts` blob is a
  downgrade path, not a two-way sync: changes made while rolled back are
  discarded on the way back up, because the presence of `credentialRoutes`
  permanently suppresses re-import. Making it two-way would mean reconciling two
  live sources, which is the thing this design removes.

**Onboarding was not broken by this phase, and the reason is worth recording**
because the design predicted it would be. The prediction assumed phase 2 removed
the `AgentId` keying from credentials outright; the projection above means
`OnboardingWizard`'s two hard-coded cards keep working unchanged, now writing
`(anthropic, sub)` and `(openai, sub)`. They keep their API-key disclosure — the
copies in Settings → Services do not, since there the key is a first-class card —
so a user with no subscription still has a way in (req 2). It is still the
interim: the step is hard-coded to two providers and lists every other agent
read-only, which `docs/257-onboarding-non-blocking` replaces.

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

**The usage-record half has landed separately, ahead of the rest of phase 3.** The ordering
constraint above is an **upper** bound — not later than the phase that starts producing
attributed turns — so landing it earlier satisfies it, and it removes the one piece of phase 3
that cannot be repaired if the phase slips or is re-cut. It was split out for two reasons
beyond that: it touches nothing phase 2 is changing, so the two could land in parallel; and a
migration that rebuilds a table is the kind of change that deserves its own review rather than
riding along with the spawn-shaping rewrite.

Nothing user-visible changed with it. With no writer yet supplying the new fields, every row
is all-null — exactly the `legacy` bucket described below — and the discriminator defaults to
the behaviour it replaced, so no existing caller changed and no displayed number moved.

What landed: `usage_turns` gains `service_id`, `billing_mode` and the four rate columns
(`rate_input`, `rate_output`, `rate_cache_read`, `rate_cache_write`) under an all-or-nothing
`CHECK`; `RecordedTurn` gains `attribution` and `costSource`, and `record()`'s trailing bag is
now `RecordedTurnExtra`, derived from `RecordedTurn` so the two cannot drift. **A single
`attribution` object rather than six loose fields**, so the all-or-nothing rule holds in the
type system as well as in SQL — the `CHECK` is the backstop for anything that reaches SQL by
another route. SQLite cannot add a table-level `CHECK` with `ALTER TABLE`, so the migration is
the standard rebuild (create, copy, drop, rename, re-create the index), guarded on the column
already existing because the migration tests rewind `user_version` and re-run every later step.
`MODEL_SELECTION_MIGRATION` and `USAGE_ATTRIBUTION_MIGRATION` are exported frozen indices for
the same reason `COLOR_BACKFILL_MIGRATION` is: phase 1's migration test rewound to `version -
1`, which silently re-targets a different step the moment one is appended — appending this one
would have done exactly that.

One defect the split surfaced, found by cross-backend review: **the delta chain had to become
keyed by `(session, subAgentId)`, not merely primary-only.** `stmtLastCumulative` selected the
last *primary* cumulative snapshot and excluded sub-agent rows, which was sufficient while
`subAgentId` itself decided the branch — a consult could never take the cumulative path at all.
The discriminator makes that combination expressible, and under the old query a consult
reporting a running total would have been diffed against the **primary agent's unrelated**
one: primary $2 then consult $9 persists $7. A wrong number, not a missing one. A running
total belongs to one conversation, so the chain is now keyed by the pair. This is a
generalization and not a behaviour change — the primary chain is the `sub_agent_id IS NULL`
key, binding NULL through `IS ?` reproduces the previous clause exactly, and a consult still
cannot perturb it. The first draft instead *documented* the primary-only chain as though it
were isolation, which is the class of thing CLAUDE.md's "verify an inherited guarantee at the
source" warns about — the guarantee was asserted in a docstring the code did not provide.

What is still phase 3's: the producers. Spawn shaping supplies the attribution, and the
sub-agent writer — which passed neither model nor route — widens with it. Phase 6 remains the
only reader. **Both landed with the rest of phase 3**; the rule they share is
`turn-attribution.ts`, in one place precisely so the two writers cannot disagree.

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
"no service recorded" is the honest option.

> **Superseded in part (planning#343).** This paragraph read "before ShipIt tracked this" and
> "it drains on its own as old sessions age out". Both were true of the bucket's founding case
> and are no longer true of the bucket: req 16 now also sends **forward**-generated
> unattributable volume here — work that resolves no model at all. What defines the bucket is
> the absence, not the date. Those rows are recorded unpriced, so only pre-feature rows can put
> *money* in it; the volume is mixed and the money is not. See phase 7's paragraphs on naming
> that resolves no model, below.

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
  `inputTokens` includes `cachedInputTokens` is upstream app-server behaviour this repo did
  not pin down ([`catalogue.md`](./catalogue.md) has the detail). Claude's are disjoint
  (`claude/adapter.ts:292` ✅). **Phase 3's spike measured it: they OVERLAP** — fed
  `input_tokens: 1000` with `cached_tokens: 800`, the app-server reports both unchanged — so
  every Codex turn would have double-charged the cached tokens at the full input rate.
  Normalized at the adapter boundary, as this paragraph required, so the pricing code can
  assume disjointness.

**These are all-or-nothing, not independently nullable.** Either every one is present or every
one is null; there is no such thing as a row that knows its service but not what it was
charged. Independent nullable columns would let a caller write half a row, and since
historical attribution cannot be reconstructed afterwards, a half-row is unrecoverable in
exactly the way this whole paragraph exists to prevent. A `CHECK` constraint enforces it at
the one place that matters — the write — rather than a convention every future caller has to
remember.

All-null is the `legacy` bucket. It needs no extra discriminator and no widening of
`BillingMode`, which stays `"sub" | "key"` and describes a *selection* rather than a row's
provenance: a legacy row is **one with no attribution, whatever produced it**, the aggregation
groups it under its own heading, and it never guesses which service it belonged to. That the
all-or-nothing `CHECK` leaves exactly one expressible unattributed shape is what let
planning#343 add a second producer without inventing a discriminator for it. Computing money at read time from the live catalogue was this doc's first answer and
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

**Phase 3 has landed.** The resolver is `resolveSpawnShaping` (`catalogue/index.ts`, pure) plus
`service-routing.ts` (orchestrator), which is the callable component this document asked for
rather than inline spawn code — phase 7 is its second caller. It answers three questions and
nothing else: which credentials this install holds (`listConfiguredCredentials`), which one a
turn authenticates with (`selectRouteForSelection`), and what the resident process was spawned
as (`sessionSpawnIdentity`). Eligibility itself is in the catalogue, stated over configured
routes; `turn-attribution.ts` is the cost rule; `ModelPicker.tsx` is the split composer.

**What the survey finally measured.** Every 🔍 on the two shipped harnesses is now closed, and
one of the answers was wrong in the catalogue rather than merely unverified. Measured against
the real binaries (CLI 2.1.220, codex-cli 0.146.0) driving a local HTTP recorder:

- **Claude Code** honours `ANTHROPIC_BASE_URL` and issues `POST <base>/v1/messages?beta=true`,
  so a service's base URL must not carry the `/v1`. `--model` is forwarded verbatim, except
  that the CLI **consumes its own `[1m]` suffix** — `glm-5.2[1m]` arrives at the service as
  `glm-5.2`. `ANTHROPIC_API_KEY` becomes an `x-api-key` header and `ANTHROPIC_AUTH_TOKEN` an
  `Authorization: Bearer` one, which is what `targetOverride` exists for and why GLM needs it.
- **Codex's `endpoint` declaration was wrong.** `model_provider` names a block in
  `model_providers`, not a base URL: `-c model_provider=<url>` fails with "Model provider `…`
  not found". The seam is a whole provider block — `name`, `base_url`, `wire_api`, `env_key` —
  plus `model_provider` pointing at it (`codex/spawn-shaping.ts`). Codex appends `/responses`
  to `base_url`, so the OpenAI rows' Responses endpoints gained the `/v1` they were missing.
- **Codex speaks Responses and nothing else.** A provider declaring `wire_api = "chat"` is
  rejected outright. So `openai-chat-completions` is unreachable from Codex however a service
  declares it, and DeepSeek — which served only Anthropic-Messages and chat-completions at
  the time — reached Claude Code and **not** Codex. An earlier reading of this design assumed
  the opposite. *(Corrected 2026-08-13: DeepSeek now serves the Responses API **natively**
  — no proxy — for both `deepseek-v4-flash` (from 2026-07-31) and `deepseek-v4-pro`
  (V4-Pro-0813), specifically to support Codex. The catalogue declares `openai-responses`
  for both, verified end-to-end through codex-cli 0.146.0 against the real endpoint,
  including the `apply_patch` tool loop.)*
- **Codex's `inputTokens` INCLUDES `cachedInputTokens`**, where Claude's are disjoint. Fed a
  response reporting `input_tokens: 1000` with `cached_tokens: 800`, the app-server reports
  both figures unchanged. Left alone that double-charges every cached token at the full input
  rate on every Codex turn — and the rates now *always* apply to Codex, which reports no dollar
  figure. Normalized at the adapter boundary (`codex-event-handler.ts`) so the pricing code can
  assume disjointness rather than each reader re-deriving it. The app-server also reports
  `cacheWriteInputTokens`, which ShipIt now carries.
- **Codex's `total` is the rollup for the whole THREAD, not for the turn** (planning#367,
  found in production 2026-08-13). `thread/resume` restores the accumulator from the rollout
  file in the persistent `~/.codex` volume, so it never resets for the life of a session and
  every row held a running total: a ~31-turn session read as roughly 11–18× its real usage, in
  `atApiRatesUsd`, in the token series — and, on a metered key where `cost_usd` is derived from
  these columns, in real money. `codexTurnTokens` (`shared/codex-token-usage.ts`) now does for
  tokens what `UsageManager.record` already did for a cumulative COST. The baseline it
  subtracts is the snapshot `thread/resume` REPLAYS under the previous turn's `turnId`,
  captured within the turn: cross-turn memory would be missing at exactly the moments the
  accumulator is not, since the adapter is constructed per turn and the container is destroyed
  on idle while the rollout file survives both. `contextTokens` reads `last` and was always
  right. Two consequences of subtracting rather than storing the rollup: a **compact-only**
  run raises the thread total with a model request of its own (measured 1000 → 2000) and now
  records it, because the next turn's baseline no longer sweeps it up; and one ShipIt session
  is **not** one Codex thread — a rewind clears `agent_session_id`, so the accumulator
  restarts with nothing in `usage_turns` to name the seam. Migration
  `CODEX_ROLLUP_REPAIR_MIGRATION` rebuilds the historical rows, cutting each chain wherever
  `context_tokens` (real occupancy) falls, which is what a restarted thread — or a compaction
  — looks like in the data. Every guard in it errs toward leaving a row inflated: diffing an
  already-per-turn chain destroys real billing history, and a visible wrong number does not.

**What phase 3 found.** Six things, three of which change what a later phase does.

- **Eligibility could not be asked of the registry's existing question.** `authConfigured` was
  a per-`AgentId` credential probe; it is now "this harness has at least one eligible model",
  computed from the catalogue join narrowed by the configured routes. `AgentInfo` also gained
  `eligibleModels`, the triples the picker actually renders, and that is what the wire carries.
  The field kept its old name through phase 9 as deliberate churn-avoidance and is now
  **`hasRunnableModels`** — an auth-shaped name describes the wrong axis once req 2 makes a
  harness runnable with no account at its own vendor at all. It is still the single gate every
  "can this harness take a turn" site reads, so the design's "`authConfigured` leaves
  `AgentInfo`" landed as the rename, not as the split into two questions sketched below.
- **The eligibility inputs are two sources, and the second is easy to forget.** A
  deployment-supplied `ANTHROPIC_API_KEY` has no row in the credential store — phase 2 is
  explicit that ShipIt only ever touches a value it put there — so a rule reading the store
  alone reports that install as having no credential and empties its picker.
  `listConfiguredCredentials` reads both.
- **Route selection was leaking across billing modes, and phase 1 predicted it.**
  `selectAccountForTurn` ends with a mode-blind reserved fallback, so a session selecting
  Anthropic's *subscription* landed on `claude-api-key` whenever no account was connected — an
  included turn quietly becoming a metered one, which is the shift req 12 refuses, arriving
  through routing rather than through failover. The account walk's answer is now taken only
  when it names an account; the env-delivered case resolves against the selected mode's own
  variable. `all_exhausted` is returned unchanged rather than falling through to the same
  mode's string credential — that is a failover decision and **phase 5 owns it**.
- **Choosing among a mode's several string credentials is still phase 5's.** Delivery hands the
  worker the first in order and the turn authenticates with exactly that one, so the two agree;
  what does not exist yet is a reason to pick a different one, which is req 12's failover.
  Phase 2's note that "req 12's second GLM key is stored and unreachable" therefore still
  stands after this phase.
- **The sub-agent's route had to be resolved from the sub-agent's own selection, not from its
  `AgentId`.** `runSubAgent` asked `selectAccountForTurn(subAgentId)` before reading the
  sub-agent defaults, so a consult whose default model is a custom service's resolved an
  Anthropic account and was then shaped — or not shaped — against the wrong credential. The
  defaults are now read first and the route derived from them.
- **Shaping fixes an existing first-party bug on the way past.** A session on Anthropic's
  `claude-env-oauth` route — a *subscription* delivered as an environment token — used to spawn
  with both `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` present whenever the install had
  both, and the CLI prefers the key. The turn therefore ran on metered billing while the router
  believed it was on the subscription. Shaping clears every Anthropic credential variable and
  sets exactly the one the selected mode names, so the selection decides which credential wins
  rather than the CLI's preference order.
- **Zeroing a subscription turn's cost breaks the delta chain, and nothing named that.**
  `cost_usd` for a subscription turn is now zero, so under the plain rule those rows store no
  cumulative snapshot either — while the CLI's `total_cost_usd` keeps rising across the whole
  resumed conversation. Switch such a session onto the same service's metered key (which req 12
  exists to make possible) and the first key turn finds no baseline and records the ENTIRE
  conversation as one turn's spend. `RecordedTurn.cumulativeSnapshot` carries the harness's
  running total forward on any turn that did not take its cost from it, so the chain is about
  continuity of the harness's own number and the column is about money. Two guards in
  `usage.test.ts`.
- **A subscription session's dollar figure goes to zero in this phase**, on the dial and in the
  usage modal, because that figure was never money. That is req 16's decision and this phase
  writes it from day one so the existing `SUM(cost_usd)` stays correct without being touched;
  **what those surfaces show instead** — the at-API-rates estimate, labelled — is settled in
  `requirements.md` and is phase 6's to build. It is the one user-visible regression this phase
  ships knowingly.

**What the cross-backend review changed.** Codex reviewed the branch under CLAUDE.md's rule
and returned nine findings; all nine held up on checking, and eight are fixed here. Three are
worth reading as a group, because they are the same mistake in three places: **a zero, an
absent status and a bare id were each read as more than they said.**

- **A consult on a metered key was recorded as free.** `SubAgentRunResult.costUsd` starts at
  `0` and is assigned only on a reported figure, so "the harness reported nothing" and "the
  turn cost nothing" were the same value — and Codex reports nothing. The producer forwarded
  that zero as a harness figure, which the native-key branch then honoured. This is the exact
  trap the pricing rule is written to avoid, walked into at the one site the rule's own
  docstring does not sit next to. `costReported` now carries the distinction.
- **An API key was translated into a subscription that does not exist.** The legacy auth
  probes are turned into an *account* credential of the harness's native service, and
  `hasAnyAuthForProvider` answers true for a bare `ANTHROPIC_API_KEY` — so a key-only install
  offered a "Subscription" row that failed `auth_required` when chosen. The probes are narrowed
  at the DI boundary to account-shaped evidence; an env key needs no translation, because
  `listConfiguredCredentials` already reads it as the credential of its own mode.
- **An unfinished account login counted as a credential.** An account row exists from the
  moment a login starts and a cancelled one stays `unavailable`, while routing accepts only
  `ready` or `authenticating`. Eligibility now asks the same question routing does — otherwise
  the picker promises something the router will not do.

Two more were real and are fixed:

- **A rotated or deleted credential survived in a resident process.** Phase 2's propagation
  updates the worker's *environment*; a CLI already running in it read its credential at spawn
  and never re-reads. So rotating a key in place kept the old one — the route id does not
  change, so neither does the spawn identity — and *deleting* one left it authenticating turns
  for the rest of that process's life, defeating the revocation phase 2 built. Every credential
  write now releases resident agents that are not mid-turn
  (`releaseResidentForCredentialChange`), so revocation takes effect at the next spawn
  boundary. A runner mid-turn is skipped deliberately: killing it would abort work the user is
  waiting on to shorten a window that closes at the end of that turn anyway. Separately, a
  pinned route whose stored credential has been *deleted* is dropped at env prep, so the
  session re-pins instead of attributing turns to a credential that no longer exists while
  delivery hands the CLI a different one.
- **New-session ingress accepted a catalogue-valid but ineligible triple.** The browser slot
  outlives a credential change, so a triple written while a subscription was connected still
  names a real row after it goes away. Gated at the slot's shared *source* on the client
  (`isSelectionEligibleForAgent`) so both readers ask, with the WS seed refusing to trust it
  server-side as well.

Three were narrower and are also fixed: Claude spawning a redirected turn with no credential
in the environment (it now raises `auth_required` as Codex already did); an **unset** sub-agent
default writing an unattributed `legacy` row forever *and* falling back to native-vendor
routing on an install that has no first-party credential (it resolves to the first eligible
entry, which is what "the harness's own first model" means); and the sub-agent defaults picker
storing an unreachable `sub` triple on a key-only install, because the store re-resolved a bare
id to the first mode of the biased service — the service layer now passes the mode the id was
chosen *from*.

**One finding was recorded rather than fixed here**, because it is pre-existing rather than
introduced: the new-session picker reads the globally-active session for its *harness* display,
as the pre-split picker did. The half this phase did introduce — reading only the saved bare id
and so highlighting the wrong `(service, mode)` — was fixed with it. The recorded half is now
closed too; see *The composer's harness display, and which session a composer is bound to*.

**Phase 4 — In-session switching.** The resident process's identity was widened in phase 3 — to the whole spawn-relevant tuple: harness, service, billing mode, API style,
endpoint, credential route, model — because phase 3 is where a same-id/different-service
switch first becomes reachable. Phase 4 is only the mid-session *interaction* on top of it:
the picker acting on a live session, across services rather than just within one.

**Phase 4 has landed.** The rules are `model-switch.ts` (pure: what a `set_model` /
`set_agent` may do to a live session, and what the user is told), applied in
`route-registry.ts`'s two handlers and confirmed to the client by a new
`model_selection_changed` message. The end-to-end proof is
`integration_tests/model-service-switch.test.ts`, which switches a resident session between
**OpenRouter and Vercel on the same model id** — the two catalogue rows that share
`anthropic/claude-opus-5` — and asserts the respawn, the new endpoint and the re-pinned
credential route.

**What phase 4 found.** The mechanism was phase 3's and held; every defect was in the
interaction on top of it, and three of the four are the same mistake — **something still
keyed on the model id after the id stopped identifying anything.**

- **An explicit triple was honoured or *re-resolved*, never refused.** Phase 3 checked the
  triple and, when it failed, fell through to bare-id resolution — correct for a client that
  sent no triple, and silently wrong for one that sent a triple ShipIt would not honour. The
  bare id re-resolves to whichever service sorts first among those offering it, so picking
  Opus on Vercel with no Vercel key moved the session to **OpenRouter** and billed it; picking
  Anthropic's *metered key* on a subscription-only install moved it onto the **subscription** —
  the same cross-mode shift req 12 refuses on failover, arriving through the picker. It is now
  refused, which is safe precisely because the picker only ever offers eligible rows: reaching
  it means the client's list is stale, and the honest answer to a stale list is to say so.
- **The optimistic pick was a model id, so a same-id switch showed no change.** The composer
  highlights the picked row before the server answers, keyed on the id — and a cross-service
  switch keeps the id. The checkmark and the disambiguating pill both stayed on the group the
  user had just left, with nothing to correct them: **nothing refreshed the session list after
  a selection change.** The pick is now the whole triple, and `model_selection_changed`
  carries the server's authoritative answer back so the two converge instead of drifting.
- **A harness switch conformed a bare id, so it could keep a `(service, mode)` the new harness
  cannot reach.** The id list is credential-narrowed, so this was never an eligibility hole —
  it is that two harnesses can both offer `anthropic/claude-opus-5` while only one reaches it
  through the service the session is pinned to. The test is now the triple against the new
  harness's eligible set, which is the same question the picker asks.
- **A switch moved three things and reported none of them.** The model, its billing group and
  the reasoning effort are computed in three places, and the design's "one message rather than
  the last one to be computed" had no implementation. `describeSelectionMove` renders all three
  as one sentence, delivered as a **toast** — feedback on a control the user just operated, so
  it is deliberately not transcript content: the state it reports is the composer's own and is
  re-read from the session row on every load.

Two things phase 4 deliberately did **not** change. The confirmation is **per-connection**,
like the sibling `error`, rather than broadcast through the runner: `emitMessage` buffers into
the turn-event log, and replaying a stale selection to a reconnecting viewer would clobber a
newer one. Other viewers' *pickers* therefore stay stale until their next session-list refresh,
exactly as before — what is no longer true is that a stale picker could affect a **turn**, and
that is the half that mattered (see the review findings below). And the composer's model
control stays **disabled while a turn runs**, so a mid-turn switch is not reachable from the
UI; the turn-start capture of the usage attribution (`agent-listeners.ts`) already covers the
paths where it is.

**The third persisted selection caught up here too.** The sub-agent defaults picker was the
last surface still speaking bare model ids — phase 3 narrowed its *list* to what the install
can run and left the ambiguity, so a deliberate choice between two services offering the same
id was inexpressible and the server guessed. It now offers one `<optgroup>` per
`(service, billing mode)` and sends the triple, which `saveGlobalSettings` validates against
the harness's eligible set rather than trusting. An **empty** eligible set still means "no
credential source is wired" (a worker, a unit test), not "nothing is eligible" — that is what
`capabilities.models` itself falls back to, so the check follows it rather than refusing every
write.

**What the cross-backend review changed.** Codex reviewed the branch under CLAUDE.md's rule
and returned six findings; all six held up and all six are fixed. Two are worth reading
together, because the phase created one of them by fixing the other: **refusing a request is
only half a decision — the other half is what the client is then left showing.**

- **A refused pick stayed on screen forever.** The composer clears its optimistic pick when
  the session row catches up with it — and a refusal leaves the row *exactly* as it was, so
  that signal never fires. Because a cross-service pick keeps the model id, nothing else on
  screen moves either: the trigger and the checkmark claimed a service the session was not on
  for as long as the tab stayed open, while every turn ran on the old one. Introduced by the
  refusal rule itself. The fix is a per-session **"the server answered" counter** rather than
  a match test, because it is true of both outcomes.
- **The refusal was reported as an `error`, whose handler appends an assistant bubble nothing
  persists** — transcript content that vanishes on reload, which CLAUDE.md rules out. It is
  now a `notice` on `model_selection_changed`, which also carries the authoritative selection
  the picker has to snap back to. One message answers both halves.
- **A stale second viewer could run the wrong model against the right service.**
  `getSelectedModel` is per-*connection* while the service, mode and credential are read from
  the session *row*, so with two tabs open a switch in A left B's closure holding the previous
  model — and a turn sent from B spawned model X at service Y's endpoint. Worse, the resident
  process was then stamped with Y's identity (`turn-executor.ts` derives it from the row), so
  the guard believed a process spawned with X was an X-and-Y process and a later switch *back*
  reused it. `buildAgentRunParams` and the usage-attribution capture now read the row first,
  which makes the model and the shaping one source instead of two. This is the same
  "two derivations of the same tuple" failure phase 3 named for the spawn identity, one layer
  up.
- **Refusal was not atomic.** `set_model` self-heals a cross-harness pick by switching the
  harness *first*, and the triple was verified after that — so a refused request had already
  moved the session to the other harness and reset its reasoning. The handler now resolves the
  harness that *would* run the model, verifies, and only then writes.
- **Half a triple was read as no triple.** `serviceId` and `billingMode` are independently
  optional on the wire, and "one missing" fell into the legacy bare-id path — discarding the
  field that *was* sent and re-resolving the id, which is the same mis-billing arriving through
  a malformed request instead of a stale one. Only *neither* field is the legacy shape; exactly
  one is refused, on both this path and the sub-agent one.
- **Two tests did not guard what their names claimed.** "Drops the optimistic pick" asserted
  the same pill before and after a *matching* confirmation, so it passed whether or not the
  pick was ever cleared. It now moves the row somewhere a surviving pick would mask. The
  suite docstring also says plainly which of its cases pin phase 3's mechanism rather than
  phase 4's.

**Phase 5 — Credential-failure policy.** Branch on the **billing mode** of the failing
selection rather than on the error text, and never on how its credential is delivered. Two gates, not one: the auth-error
interception must not drag a key-authenticated service into vendor re-auth, and the
same-turn quota retry needs the same billing-mode gate that account benching already
has. Establish Codex coverage rather than assuming it.

**Phase 5 has landed.** The rule is `credential-failure-policy.ts` — one function every
gate asks, so the branch cannot be drawn differently in two places. Around it:
`service-routing.ts` gained the string-credential walk (which of a subscription's
credentials a turn takes, and `all_exhausted` when none is left),
`credential-store.markCredentialRouteExhausted` is the bench, and `session-agent-env.ts`
moves an already-pinned session off a spent credential the way `failoverPinnedSession`
already moved one off a spent account.

**Where the gate went, and why not where the design said.** The design located the fix at
`AUTH_ERROR_PATTERNS` (`process.ts`) — "fixed by *deleting* behaviour". What is deleted is
the *recovery*, and the deletion is in the **orchestrator**, not in the worker. Three
reasons, in order of weight:

- The worker knows a billing mode only for a **shaped** turn, and the orchestrator knows it
  for every turn — it is a column on the session row. Gating in the worker would leave the
  unshaped cases (an account-delivered credential, a session that has pinned nothing yet)
  answering from no evidence.
- It is **one gate for both harnesses**. Claude detects auth failure by matching text and
  Codex by sniffing stderr and by structural pre-flight, and both funnel into one
  payload-free `auth_required`. Gating downstream of that is what makes "establish Codex
  coverage" a property of the design rather than a second implementation to keep in step.
- The **interception itself is still right**. It is what keeps the CLI's "Please run
  /login" out of the transcript — copy a ShipIt user cannot act on either way. What was
  wrong was everything that came *after* it: `willRecoverAuth` (heal an OAuth token that
  does not exist, then re-run the turn on the same bad key), `onAgentAuthRequired` (nudge
  the *harness vendor's* refresher because a DeepSeek key was rejected, which can broadcast
  a global "Sign in" toast), and the "Open Settings → Agents to sign in" copy. All three are
  skipped for a `key`, and the message names the failing service and points at Settings →
  Services.

**Codex coverage was not there, and closing it is this phase's second gate.** The design
flagged it as unestablished; reading the two paths confirmed it. Codex reports a spent
subscription by refusing `turn/start`, and a rejected JSON-RPC request becomes an
adapter-level **`error`** (`codex/adapter.ts`'s `initializeAndRun(...).catch`) rather than
the `agent_result` that req 14's same-turn failover and req 7's exhaustion stamp both
watch. So a Codex subscription running out mid-turn benched nothing and failed over
nowhere. `willRetryOnQuotaError` is the `error`-path twin of the `agent_result` branch,
wired as a synchronous gate the listener asks *first* — the same shape as
`willRecoverAuth`, and for the same reason: everything below it is the terminal teardown of
a turn that has ended, and a turn about to be re-run has not ended.

**What phase 5 found.** Five things, three of which are gaps earlier phases asserted closed.

- **Delivery and routing would have disagreed the moment failover worked.** Phase 3 noted
  that delivery hands the worker a mode's *first* credential and the turn authenticates
  with exactly that one, "so the two agree" — true only while nothing could pick a
  different one. Failover is precisely that reason: a session moved onto the second GLM key
  would have kept authenticating with the first, because it is the only one in the
  environment, billing the credential ShipIt had just benched and attributing the turn to
  the other. Every stored credential is now also materialized under a name of its own
  (`credentialRouteEnvName`, `SHIPIT_CREDENTIAL_<id>`), and spawn shaping sources the
  **pinned route's** variable. The group name is untouched, because a session with no
  pinned route still reads it. The cost is that a session's environment holds every
  credential of a service rather than one — all the same user's, for the same service,
  where the environment already carried every service and mode they have configured.
- **Phase 3's stale-route drop re-selected but never re-pinned.** `setProviderRoute` sits
  inside the `!session.agentPinned` branch, so an already-pinned session kept naming the
  removed credential on its row: every later turn re-resolved correctly while `usage_turns`
  and the spawn identity recorded a credential the turn had not authenticated with
  (req 11). The move is persisted now, for the removal case as well as the new benched one.
- **`selectRouteForNewTurn` bailed without a `ProviderAccountManager`.** That early return
  predated a world where a credential could live anywhere else, and it made a GLM-only
  install — no accounts at all, which is the install this whole feature exists for —
  resolve no route, pin nothing, and get no failover. `selectRouteForSelection` answers
  correctly without one; a session with no selection still reaches `auth_required` and so
  still resolves `undefined`, which is what preserves the pre-feature behaviour.
- **Phase 3 deferred one decision to this phase and the answer is "no".** When every
  connected *account* of a mode is spent, `all_exhausted` stays terminal rather than
  falling through to that mode's env-delivered string credential. The env credential
  carries no row, so ShipIt tracks no quota for it, cannot bench it after it fails, and
  cannot name it in the transcript — rolling onto it would replace req 13's "the earliest
  window resets at X" with a second failure and a worse message. A hop ShipIt cannot see
  the far side of is one it does not make. The same rule shapes the string walk: the
  deployment's environment is reachable only when *nothing* is stored, which is exactly
  what phase 3 did.
- **The routing controls close only as far as they can honestly work.** Phase 2 deferred
  both to here. The **selection mode** now does something for a string-delivered
  subscription — `strict` takes the user's fallback order, `balanced` the
  least-recently-used credential — and has a control on the card. The **cutoffs** do not
  ship: a cutoff is a percentage of a reported quota, and nothing reports one for a
  string-delivered subscription until phase 6 builds `zai-plan-usage`. Shipping the control
  inert would be the dishonesty req 10 refuses one surface over, so it waits for the quota
  reader rather than for the failover.

**What the cross-backend review changed.** Codex reviewed the branch under CLAUDE.md's
rule and returned three findings; all three held up on checking and all three are fixed.
The first is the interesting one, because it is this phase's own rule applied to only one
of the two axes it needs.

- **A subscription that is not the harness vendor's still went through vendor recovery.**
  The gate as first written asked one question — is this `key`? — and sent every `sub`
  down the docs/179 path. For GLM's coding plan that heals an Anthropic OAuth token that
  has nothing to do with the failure, nudges Anthropic's refresher (which can broadcast a
  global "Sign in" toast naming the wrong service), and — the part that actually breaks
  req 12 — leaves the dead credential selected, so every later turn picks it again and the
  healthy second credential is never reached. **There are two axes, not one**:
  `stopsOnFailure` is the *billing* question and `vendorOwnedRecovery` is "whose healer can
  act on this credential", which is decided by whether the failing service is the harness's
  `nativeService`. A non-vendor subscription now skips both vendor flows, is **benched**
  with the self-expiring unknown-reset lockout, and says so — the next turn fails over.
  Deliberately not a same-turn re-run: a re-run on an auth failure is docs/179's flow and
  it exists to heal a stale OAuth token, which is exactly what a supplied key does not
  have.
- **A failed retry on the new error path would have stranded the turn.** Returning `true`
  from `willRetryOnQuotaError` claims a turn nobody else will finish: the listener has
  surrendered its terminal cleanup and the dead process's `done` stands down. If the
  history writes or the re-dispatch threw, `running` stayed true with the turn's edits
  uncommitted — CLAUDE.md's "every terminal path runs the commit", broken by a path that
  *looks* terminal and is not. Everything that can throw now runs **before** the claim and
  un-claims by returning `false`; a rejection after the claim runs the same teardown
  `recoverAuth` runs on a failed heal.
- **A rotated credential kept being delivered from a stale compose snapshot.** The
  per-credential merge filled a gap but did not overwrite, so a compose-backed session
  whose YAML happens to be unparsable — the case the *dropping* half of that function
  exists for — would keep pushing the old secret after a replace, indefinitely. The store
  now wins outright for `SHIPIT_CREDENTIAL_*`, which is safe for exactly that prefix
  because it is ShipIt's own namespace and a compose file cannot legitimately declare it.

One thing the review did not raise and the fix above exposed: **`describeAccountSelectionFailure`
was still harness-shaped.** "Every connected Claude account is out of quota" is the wrong
sentence for a spent GLM coding plan that happens to run on the Claude harness, and req 12's
"stops and says so" is that sentence. It takes an optional subject now — the service's name,
supplied only when the selection is not the harness's own vendor, so the first-party wording
is byte-identical.

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

**Phase 6 has landed.** The split is `UsageGroup` / `UsageTotals` / `usageTotalsFrom`
(`shared/types/usage-types.ts`) over a `foldSplitRows` aggregation in `usage.ts`; the quota map
is re-keyed to `${serviceId}:${billingMode} → routeId → limits` (`usage-limits-types.ts`,
`limits-registry.ts`); and the display rules are `sessionRunningFigure` /
`compareSessionsBySpend` (shared, so the dial and the modal cannot drift) plus
`client/utils/format-cost.ts`.

**The aggregation groups by `(service, mode)` AND by the rate set**, which is the one shape
decision worth stating. "At API rates" recomputes from each row's *persisted* rates, and a
`(service, mode)` pair accumulates several rate sets over time — two models, or one model
after a price edit. Grouping by the rate columns lets a single `costFromRates` call price a
whole bucket, so the formula lives in **one** place (`turn-attribution.ts`) instead of being
re-expressed in SQL. Legacy rows have all six attribution columns NULL together and SQLite
groups NULLs as equal, so they fall into exactly one bucket with no rate set at all — the
exclusion is a property of the data rather than a filter someone has to remember.

**What phase 6 found.**

- **`SessionUsage.totalCostUsd` had to go, not gain a sibling.** Keeping it would have left
  `SUM(cost_usd)` — metered *plus* legacy — reachable under a name that reads as "the cost",
  which is the conflation req 16 exists to end. It is replaced by `totals: UsageTotals`
  throughout, including on `usage_update` / `turn_usage_update`. That is the widest part of
  this phase's diff and none of it is optional: every one of those readers was showing a
  figure whose meaning changed.
- **The dial needed a rule, not a field.** Three kinds of figure and one slot, so
  `sessionRunningFigure` picks money → estimate → pre-feature accounting, in that order, and
  the popover lists whichever of the three exist as separate rows. The `earlier` case is what
  stops a long-lived session silently losing a total the user has already seen.
- **The pre-rehydration fallback had the same bug as the server would have.** `ContextDial`
  falls back to summing the turn series when session totals have not arrived; summing `costUsd`
  there reports a subscription session as having spent nothing. It now splits by
  `TurnUsage.billingMode`, which is why that field (and `atApiRatesUsd`) is on the per-turn
  shape at all rather than only in the aggregate.
- **A quota snapshot belongs to the ROUTE's owner, not to the harness that reported it.**
  `recordAgentRateLimits` resolves `(service, mode)` from the credential route the turn ran on
  (`credentialOwnerForRouteId`, `service-routing.ts`) and drops anything that is not a `sub` —
  so a redirected turn cannot file another vendor's usage against Anthropic's quota, and
  `claude-api-key` stops producing a pill for a mode that has no allowance (req 10).
- **The `/api/limits/refresh` body changed shape**, from `{agentId}` to
  `{serviceId, billingMode}`, and rejects a `key` mode outright: req 10 says such a mode shows
  no indicator, so there is no button and asking is a request for something that does not
  exist rather than a silent no-op.
- **`normalizeAgentUsageLimitError` still keys on the harness**, deliberately: its wording
  describes the harness's own vendor subscription ("Claude's 5h usage limit"), so it looks up
  that harness's `nativeService` `sub` group. A redirected turn finds no window there and the
  upstream text passes through intact, which is the honest outcome rather than a silent
  reclassification.

**What the cross-backend review changed.** Codex reviewed the branch under CLAUDE.md's rule and
returned five findings; all five held up on checking and all five are fixed. Three are the same
mistake in three places: **a figure existed somewhere the contract does not put it.**

- **A key row carried an "at API rates" figure.** It was computed for every attributed row and
  documented as an audit value, with `usageTotalsFrom` ignoring it — but a comparison figure
  sitting beside the spend it duplicates is one careless `reduce` from doubling the metered
  total, and it contradicted the requirement's own scoping in the wire shape. It is now
  populated for `sub` rows only, on the group, on the turn, and on the live emit.
- **The by-spend ranking summed `metered + legacy`** — a hidden fourth figure no row renders, so
  a session displaying $0.10 could outrank one displaying $10.00, and it performed the one
  addition the split forbids. It now ranks on `sessionRunningFigure`, i.e. on the figure the row
  actually shows, which is also the only ordering a reader can verify by looking at the column.
- **The weekly chart called a rate-derived series "Paid".** `catalogue.md` is explicit that a
  figure from four unit rates cannot be labelled that way; the toggle now says **Metered** and
  the per-turn column header says **Cost (est.)**. The `≈` marker stays reserved for the
  at-API-rates comparison — overloading it to mean "estimate" would erase the distinction the
  split rests on, so the qualifier goes in the header instead.

Two more were real and are fixed:

- **Every live turn blanked the current session's split.** `usage_update` REPLACES
  `currentSessionUsage`, and it carried totals only — so the "by service" section that
  `/history` had hydrated vanished on the next turn and stayed gone until a reload (the
  fetch-on-open refreshes all-session stats, not this). The message now carries `groups`.
  Retaining the previous groups instead was rejected: they go stale exactly when the session
  changes mode, which is when the split matters most.
- **A sub-agent consult's quota went to the wrong subscription.** The consult resolves its own
  credential route and can fail over mid-run, but forwarded no route — so the orchestrator
  re-derived one from the session. Under the old per-`AgentId` keying that was merely imprecise;
  under req 10 it is wrong in kind, because the snapshot is filed against whatever `(service,
  mode)` **owns** the route: a consult on a DeepSeek key would be filed as the session's
  Anthropic subscription quota. `recordAgentRateLimits` gained an explicit `routeId` and the
  consult passes its own.

**Not in this phase, and still open:** GLM's `zai-plan-usage` quota reader (**planning#339**). Phase 2 deferred it
for want of somewhere to report into; that place now exists (a provider declares its
`(serviceId, billingMode)` and the registry indexes on it), so the reader is an addition rather
than a change. Req 15 stays unmet on GLM's quota until it lands.

**Phase 7 — Non-turn work.** Session naming and PR descriptions get their own explicitly
chosen `(service, billing mode, model)`, visible as a setting whose unset state resolves to
the first eligible model rather than to a named one. Includes
normalizing a blank PR generation into the generic fallback — today's code returns the
empty string in containerized production — and the durable, dismissible failure notice.

The largest phase after the first, because it is the one place with no existing seam.

**Phase 7 has landed.** The setting is `CredentialStore.nonTurnModel`; the resolver is
`orchestrator/non-turn-model.ts` (req 9's derived default, the derived harness, the credential
route and the spawn shaping); the runner is `orchestrator/services/non-turn-work.ts`, wired as
the production `generateText` in `bootstrap-managers.ts`. `session-namer.ts` takes the resolved
target instead of an `AgentId`, and the notice is a persisted `NonTurnFailureCard`. Settings →
Services grew a **Background work** row (`BackgroundWorkSection.tsx`).

**Where that row lives (2026-08-11).** It sits in the Settings **tab**, below a divider under
`ServicesPanel` — not *inside* the panel, which is where it was first put. Same place on
screen, different owner, and the owner is the point: docs/257's onboarding hosts
`ServicesPanel`, so anything inside the panel is also asked of a first-run user who has not yet
connected anything. The setting's whole design is that unset is a working state which follows
the install (req 9's derived default), so there is nothing for that user to decide and the row
was spending the screen the credential needed. Req 9 is unchanged: the setting is visible, in
Settings, with the default labelled by what it resolves to.

**What phase 7 found.** Six things, and three of them change a claim this document made.

- **The shaping rules had to leave `src/server/session/`.** Naming shells out to a CLI from
  the **orchestrator**, which must not import that tree — the prod image omits it precisely to
  keep the boundary honest. `applyServiceRouting` and `codexProviderArgs` moved to
  `shared/spawn-routing.ts` and the two session-side modules re-export them. Sharing the
  function rather than writing a second one is what stops a naming run from authenticating
  differently from the turn it names; this document had not noticed the boundary at all.
- **"Naming already runs a model, so it is parameter work" understated it by one field.** The
  call took `(userText, agentId, credentialRoot)` and returned a string, so it could express
  neither the model nor the shaping *nor the spend*. Recording the spend needed a second
  change the design did not name: Claude Code's naming invocation moved from
  `--output-format text` to `json`, whose envelope carries `usage` and `total_cost_usd`. The
  parse is guarded — an unrecognized envelope degrades to reading stdout as text, which is
  exactly the previous behaviour — because naming must not start failing to protect a metric.
- **A row is written only when the harness reported telemetry.** Codex's `exec` reports none
  through this path, and an all-zero row priced through the catalogue's rates says "this was
  free", which is a *wrong* number rather than a missing one — the exact trap
  `turn-attribution.ts`'s docstring is written around. The honest gap is logged instead. This
  narrows the phase's "record it" answer: naming on Codex is recorded as nothing, not as $0 —
  a real gap the cross-backend review flagged, carried as a phase-6 checklist item rather than
  closed with a number nobody can stand behind.
- **The notice needs two failure shapes, and only one of them names a service.** A pin the
  install can no longer run names the service that went away; an install with **no** eligible
  model anywhere names nothing, because no service failed — a notice there would fire on every
  session of a half-configured install and be unactionable. `NonTurnResolution` splits them
  (`pin_unavailable` vs `nothing_eligible`) and only the first raises a card.
- **The setting is a fourth persisted model selection, and it strands on a retirement like the
  other three.** Phase 1 enumerated three; this is the fourth. `resolveNonTurnModel` resolves a
  retired pin through `retirementSuccessor` (req 13) at **read time** and does not write back —
  unlike a session, nothing displays this selection as "what is running right now", so there is
  no second precedence rule to keep honest and the user's pin stays what they typed.
- **A PR generation with no live runner is reported, not resolved by booting a container.**
  This document says the ordinary activation path covers it, and in practice it does — PR
  creation is a user action on an active session, and the post-turn flow runs while the
  container is up. Where it does not, the generator raises the notice and returns empty rather
  than starting a container as a side effect of formatting prose. Stated because it is a
  narrowing of "this is the ordinary activation path".

**What the cross-backend review changed.** Codex reviewed the branch under CLAUDE.md's rule and
returned nine findings; all nine held up on checking, and eight are fixed here. Three are worth
reading as a group, because they are the same mistake in three places: **a guard, a helper and a
window that each belonged to the turn path were not carried across to the non-turn one.**

- **The retirement path was dead before it ran.** `getNonTurnModel` filtered the stored pin
  through `selectionExists`, and a retired model is in `mode.retired` rather than `mode.models` —
  so the pin read as *unset*, the derived default silently took over, and `resolveNonTurnModel`'s
  successor lookup was unreachable. A retirement therefore discarded the user's choice instead of
  following it through, which is the opposite of what req 13 promises. The store now accepts a
  pin that names a retired row too; deciding what to *run* stays the resolver's job. The unit
  test that "passed" was testing the resolver with a fake store, which is exactly how a dead
  production path survives a green suite.
- **The credential window was missing entirely.** `runSubAgent` provisions the spawned harness's
  credential subtree, syncs the token back and wipes it; the non-turn spawn did none of that.
  Non-turn work is chosen *independently of the session*, so its harness and its account are
  routinely not the ones the session's container holds — and Anthropic's subscription is the
  **first catalogue row**, so an account-backed background model is the default install rather
  than a corner. The full `provision → spawn → sync-back → wipe → restore-the-session's-account`
  cycle is now here too.
- **Naming inherited the orchestrator's own environment credentials.** It copies `process.env`,
  and an account-delivered selection has no `ServiceRouting` to shape, so nothing cleared an
  ambient `ANTHROPIC_API_KEY` — which both CLIs prefer over the login on disk. The dogfood `dev`
  service sets one. Phase 3 fixed exactly this for turns; `scrubHarnessEnvCredentials`
  (`shared/spawn-routing.ts`) is the same rule for the orchestrator's own shell-out. Phase 7 made
  it sharper than it was, because the run is now *attributed* to the selected mode — so the
  mismatch became a wrong record and not just a wrong bill.

Three more were real and are fixed: the secret was re-derived by walking storage order while
routing picks by priority, so a naming run could authenticate with a different credential from
the route its usage row named (it now comes from the resolved route); dismissal patched only the
database, so a notice dismissed while its turn was still running was rebuilt away by that turn's
finalize (`persistCardTransition` now, the same fix docs/164, docs/177 and docs/193 each needed);
and the direct `POST /pr/description` endpoint still returned the empty string for a blank
generation, which is the exact behaviour req 9 calls a change.

Two were client-side and are fixed: a pin the install can no longer run was absent from the
select's options, so the control read as *the default* while the server still held and failed the
hidden pin — it now renders as unavailable, with the warning beside it; and the card's dismissed
flag was seeded into `useState` at mount, so a dismissal arriving from another attached viewer
left that copy expanded until a remount.

**CI found a seventh thing, and it is a design decision rather than a slip: the two "no model"
answers are different facts.** The first cut treated an unresolvable selection as one case and
refused to run — which broke a control test that names a session on an install with no
credentials at all, and would have broken the same case in production. The distinction that
resolves it:

- **A stale pin** (`pin_unavailable`) is a service the *user chose* that went away. Naming stops,
  the placeholder title stays, and req 9's notice says which service. Running something else
  would defeat the choice, which is the whole point of the setting being explicit.
- **Nothing eligible** (`nothing_eligible`) is ShipIt having *no opinion*. Req 9's default is a
  rule for choosing among models the install can run; with none to choose from there is no
  choice to make, and refusing to run is a regression rather than a policy. Critically,
  `listConfiguredCredentials` reads the credential store and the environment — **not** a CLI
  logged in on the host outside both — so a dev checkout and a hand-authenticated deployment both
  land here, and both named their sessions perfectly well before this feature. Both halves
  therefore fall back to their pre-feature path: naming spawns the session's own harness with no
  model and no shaping, and text generation delegates to the injected generator.

No notice fires for the second case, deliberately: nothing failed, and a notice would appear on
every session of a half-configured install while naming nothing the user can act on.

**One finding was recorded rather than fixed, and it is now closed by measurement**
(planning#341). `recordNonTurnUsage` writes nothing when the harness reported no telemetry, and
plain `codex exec` reports none — so **naming on a metered OpenAI key spent money and recorded no
row**, which collides with req 16's split reading as exhaustive. Phase 7 left it open because the
two available answers were wrong in different directions: an all-zero row priced through the
catalogue's rates asserts "this was free", a *wrong* number rather than a missing one, and the
alternative — parsing `codex exec --json` — rested on an event shape nobody had verified, so
shipping the parser risked breaking naming outright on every Codex install to fix a metric.

**The shape is now verified, so the measurement is the answer and req 16's label stands
unamended.** Against codex-cli 0.146.0 (the version `docker/agent-cli` pins) driving a local
Responses recorder — phase 3's method — `codex exec --json` prints JSONL whose `turn.completed`
carries the turn's `usage`, and whose `item.completed`/`agent_message` carries the text naming was
already scraping off stdout:

```
{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":800,
  "cache_write_input_tokens":0,"output_tokens":42,"reasoning_output_tokens":7}}
```

Three things that shape the parser, all observed rather than assumed. **`input_tokens` includes
`cached_input_tokens`** — the same overlap the app server reports, so the same subtraction
applies; that rule now lives in `shared/codex-token-usage.ts` rather than in the adapter, because
this made the orchestrator a second reader of the same figures under different key names and a
second implementation is how the two boundaries come to disagree. **`output_tokens` already
includes `reasoning_output_tokens`**, which is reported alongside as a breakdown, so carrying both
would double-count reasoning. And **an `error` item is not necessarily fatal** — an unknown model
id emits one and the turn then completes normally — so an error message becomes the failure detail
only when no agent message arrived. A stream the parser does not recognize degrades to reading
stdout as prose, which is exactly the pre-`--json` behaviour, so an unexpected CLI never costs
naming its title to gain a metric.

Codex still reports **no dollar figure**, which is unchanged and correct: `costReported` stays
false and the row prices from the catalogue's rates, exactly as a Codex *turn* does. What is
closed is the token gap, on both halves — the naming shell-out through this parser, and PR
descriptions through `spawnSubAgent`, which already carried the app server's figures.

**Cross-backend review found a pre-existing pricing defect on the way past, and it is fixed
here.** Phase 3's normalization subtracted only `cachedInputTokens` out of the input total while
emitting `cacheWriteInputTokens` beside it — but measurement shows Codex passes the Responses
`input_tokens` **total** through untouched and reports *both* cache figures as details of it
(fed `input_tokens: 1000` with `{cached_tokens: 800, cache_write_tokens: 50}`, it reports exactly
those three numbers). `costFromRates` charges each class a **replacement** rate — the catalogue's
`cacheWrite` is "1.25× the uncached input rate" for OpenAI and literally `=== input` for DeepSeek
and GLM — so a cache-written token left inside `input` is billed twice, once at the ordinary rate
and again at the write rate. Both details now come out of the total, on the turn path as well as
the naming path, and the adapter test that missed it (it carried no cache-write case at all) has
one. The same review found that a present-but-empty usage block became `{input: 0, output: 0}`
and so priced to $0 — the forbidden "this was free" row arriving through the back door — so
"reported nothing" now covers an empty block as well as an absent one.

**One escape remained after the Codex work above, and it was neither Codex-specific nor that
issue's** (planning#343). In the `nothing_eligible` fallback, `graduateSession` leaves `target` undefined and
names on the session's own harness anyway; recording was gated on `target && result.usage`, so
those tokens were reported by the CLI and then dropped. It predates the Codex issue, applies to
**both** harnesses equally, and was not fixable by measurement: with no configured route there
is no service, no billing mode and therefore no rate table, so the run is unattributable and
unpriceable by construction. It was filed rather than answered, because where that volume
belongs changes what req 16 promises.

**Answered: req 16's legacy group.** The tokens are real and their attribution does not exist,
which is the same condition as a pre-feature turn reached forward in time rather than
historically — so the bucket that already exists for "the attribution is not in the data" is
where it goes. The gate becomes `if (result.usage)`; `recordNonTurnUsage` takes the harness that
actually ran it (`target?.harnessId ?? agentId`) plus an **optional** target, and with no target
writes an all-null-attribution row. No discriminator was added and `BillingMode` was not
widened: the all-or-nothing `CHECK` already makes "no attribution" the single expressible
shape, which is exactly the shape these rows need.

**The row is unpriced, and that is a rule rather than a coincidence.** `cost_usd` is a hard
zero, not `resolveTurnCost`'s no-attribution default — which is the harness's own dollar figure,
and Codex reports none, so that route lands the row at `$0` under the name of a measurement.
That is the trap this feature has now walked into twice (a metered consult recorded as free in
phase 3, an empty Codex usage block priced to $0 in the paragraph above). A zero written
*because there is no price* is a different fact from a zero written *because the price was
zero*; what keeps a reader from confusing them is that the row carries no rates at all, so
nothing downstream can turn it into a figure. `costSource` stays `per-turn`, so the zero never
becomes a cumulative baseline the next run of the same harness diffs against. A run that reports
*only* a dollar figure and no tokens records nothing: volume is the entire content of the row.

**Two consequences, both honoured rather than left implicit.** First, the legacy group is no
longer purely historical and no longer drains on its own — every surface that said so is
corrected (`usage.ts`, `usage-types.ts`, `UsageModal.tsx`'s group name, `mockup-usage.html`, and
phase 6's paragraph above). Second, an unpriced row still has to *render*, and `formatCost(0)`
is `$0.00` — the free-work assertion arriving through the display rather than the write. A
legacy group whose `costUsd` is zero therefore shows **"Unpriced / no rates recorded"** instead
of a figure; the headline, the dial and `sessionRunningFigure` were already gated on `> 0` and
needed nothing. Cross-backend review caught this: the row was written honestly and drawn
dishonestly.

**The "earlier accounting" label is kept, and it is not a claim that the bucket's money is all
pre-feature.** The rows this change adds are unpriced, so they add none of it — but a *sub-agent*
consult whose stored default predates the triple resolves no attribution either
(`services/sub-agent.ts`, where `subSelection` is `undefined` for a bare model id) and keeps the
harness's own dollar figure. That is phase 3's shape and is left alone here; the label says what
can be said of a legacy dollar — that its provenance is unknown — rather than when it was spent.

**The PR-description half needed a second writer, in a place the first pass got wrong.** Its
`nothing_eligible` path calls the pre-feature `fallback`, and in container production that
spends nothing: there is no in-process agent, so the call returns the empty string
(`app-di.ts`). Under `RUNTIME_MODE=local` there *is* one, and it spawns a real CLI — so the
dogfood runtime had the same measured-then-dropped tokens naming did. The recording cannot live
in `makeNonTurnGenerateText`, which sees only a returned string and cannot tell whether a CLI
ran; it lives with the producer. `opts` is forwarded to the fallback so app-di's generator can
read `agent_result` and write its own unattributed, unpriced row when a session was named. The
post-interrupt commit message passes no session and so records nothing, which is correct — it
has nothing to attribute to.

**One shape carried over from the sub-agent path deliberately.** The usage row is written with
`subAgentId` set to the **derived harness**. It is what the row is — a one-shot spawn of that
harness rather than the pinned agent's turn — and it is what keeps the row out of the primary
conversation's cumulative delta chain (`usage.record` keys that chain by
`(session, subAgentId)`) and out of the context dial. Phase 6 splits by `(service, mode)` and
is unaffected either way.

**Phase 8 — Model retirement.** Per `(service, billing mode)`, a record of each retired model
— its id, the styles it was declared under, and a successor per style (`RetiredModel`) —
resolved where the session's model is read, generalizing the existing
`normalizeCodexModelId` shim. Small, but it is what lets curation happen without stranding
sessions, so it should land before the catalogue is trimmed in anger.

**Phase 8 has landed.** The resolver is `retirementSuccessor` (full triple) and
`resolveRetiredModelId` (bare id) in `catalogue/index.ts` — pure catalogue lookups — plus
`applyModelRetirement` in `orchestrator/model-retirement.ts`, which resolves a session and
**persists** the successor. The `RetiredModel` rows and their authoring-time invariants came
with phase 1, so this phase added no catalogue shape; what it added is the resolution and its
call sites.

Where it resolves, and why each site:

- **WS connect** (`route-registry.ts`) — before the connect-time self-heal, which otherwise
  sees an id no harness lists and drops the session onto `models[0]`: a model the user never
  chose, re-resolved onto whichever mode sorts first. The integration guard uses exactly that
  difference — a session on `(openai, key, gpt-5.6)` must come back on the **key** mode, since
  the self-heal would silently move it to `sub`.
- **The system-turn reader** (`runner-registry-factory.ts`, both `getSelectedModel` closures)
  — a Fix-CI, child-session or dispatched turn never connects a WebSocket. Resolved at the
  *source* rather than inside `buildAgentRunParams` because that same reader feeds usage
  attribution, so normalizing later would record a turn against a model that never ran it
  (req 11).
- **Child spawn** (`child-sessions.ts`) — a spawn resolves the parent before seeding the
  child, and now passes the **whole triple** rather than a bare model id. Both halves are
  needed and only the first is about retirement: a bare id re-resolves to whichever mode sorts
  first, so a parent on a service's metered key was seeding its child onto that service's
  subscription — the cross-mode move reqs 12 and 13 both refuse, arriving through the spawn
  path. That is a phase-1 gap ("the selection becomes the triple throughout" missed this
  caller) which phase 8 closes because req 13's guarantee depends on it.
- **Sub-agent defaults** (`credential-store.migrateSubAgentDefaults`) — the third persisted
  selection phase 1 flagged. Not literally "the session's model", but it strands identically:
  the spawn would forward an id the CLI can no longer run. `agentId` there *is* the harness.
  It runs in the existing load-time migration rather than in the getter, because a retirement
  only ever arrives with a new catalogue — i.e. with a new process — so once per load covers
  it without putting a synchronous save behind every read.

**`normalizeCodexModelId` is deleted, and deliberately not re-created as a bare-id helper for
a spawn boundary to call.** The first cut generalized it in place, and cross-backend review
found that unsound: req 5 lets two services offer the same model id, so an id one service has
retired while another still offers it would be rewritten to the *first* service's successor —
overriding a correctly resolved selection with a model the session's own service does not
serve, at its endpoint, on its credential (req 11). A boundary holding only an id cannot tell
those apart. It is also unnecessary: `AgentRunParams.model` has exactly two producers
(`buildAgentRunParams`, `buildSubAgentRunParams`), and both read something that resolves
first. So the Codex turn boundary now forwards what it is given, and the adapter test that
pinned the old rewrite asserts the pass-through instead, with the behaviour it protected
asserted a layer up.

**What the phase does not resolve, and one claim it does not make.** The browser's
`vibe-model-id` slot seeds a *new* session rather than pinning an existing one, a seed the
catalogue cannot place already degrades to req 9's first-eligible default — a default, not a
stranding — and the reader has no harness to check a successor against. And when a retirement
has no successor for the session's harness, `applyModelRetirement` **moves nothing**; it does
*not* follow that the session stays put, because WS connect still replaces a model no harness
lists with the harness's first one, exactly as it does for any alias or versioned slug. That
self-heal is pre-existing and phase 8 does not change it, so the honest statement is that the
resolver declines to guess — a missing successor degrades to today's behaviour rather than to
"untouched". An earlier draft of this section claimed otherwise.

**Phase 9 — Harness install selection.** Which harnesses a deployment installs becomes a
build input, defaulting to Claude Code and Codex. This supersedes the never-implemented
sketch in `docs/154-cursor-agent-adapter`, which proposed the same mechanism for the same
reason. Last because nothing else depends on it, and because it is the phase most likely
to be deferred — though not for free: req 14 is unmet until it lands, so deferring it is
a requirement left open rather than a phase skipped.

**Phase 9 has landed**, ahead of phases 2–8. The input is **`SHIPIT_HARNESSES`** (a
comma-separated list of harness ids, default `claude,codex`) rather than docs/154's
per-CLI `INSTALL_*_CLI` booleans: one list is one build arg per image whatever the
catalogue grows to, where a boolean per harness is a new arg — in two Dockerfiles and two
compose files — for every harness added. The report path is docs/154's,
`/opt/shipit/agents/installed.json`.

`docker/agent-cli/install-agent-clis.sh` is the single consumer, run by **every** image
that carries the CLIs (`Dockerfile.prod`, `Dockerfile.session-worker.prod`, and the dev
and dogfood images). It keeps docs/141's pinned install exactly as it was — one committed
manifest, `npm ci` against the committed lockfile — and **prunes** the deselected
harnesses afterwards, because npm cannot omit an arbitrary dependency from `npm ci` and a
manifest split per CLI would fork the Renovate + contract-test flow docs/141 exists to
keep single. Pruning is by npm-scope *prefix*: both CLIs ship platform-specific optional
dependencies (`@anthropic-ai/claude-code-linux-x64`, `@openai/codex-linux-x64`) that an
exact-name removal would leave behind.

`AgentRegistry.detect()` now reads that report and only falls back to `which` when no
report exists — a checkout, a unit test, or a pre-feature image. That fallback is why
`readInstalledHarnesses` returns `null` for "nothing declared" and `[]` for "declared and
empty": collapsing them would let a missing or corrupt report silently empty the picker on
every existing deployment. A report that names harnesses and leaves *none* recognizable —
`{"harnesses":["future-id"]}` — is corruption rather than a choice, since the installer
refuses an empty selection, so it reads as "nothing declared" too (cross-backend review
found that hole; the first cut returned `[]` and disabled everything).

What phase 9 found:

- **Gating every *selection* path is not enough, and enumerating them does not converge.**
  The HTTP `set_agent`, its WS twin and the picker already checked `installed`;
  `runSubAgent` and `spawnChildSession --agent` did not, and were given the check. But
  cross-backend review then found four more ways an *effective* agent arrives without
  passing any selection gate — a session pinned before the harness was dropped, a stale
  `vibe-agent-id` in a browser, Quick Capture deriving one from the static catalogue, a
  child inheriting its parent's, a plugin-install session pinning a requested one. That is
  a list that grows, so the gate that has to hold is **turn admission**:
  `agentAdmissionError` (`services/agent-auth-gate.ts`) refuses an uninstalled harness at
  the last point before a CLI is spawned, and both admission callers go through it. The
  design already named this as "the one that matters most"; phase 9 is where that stopped
  being about credentials only. It is checked *before* auth, because "sign in to Claude" is
  a dead end on an install with no Claude Code to sign into.

  Quick Capture is the one path that cannot use it — it dispatches straight onto the
  runner — and so falls back to the install's default agent with a warning rather than
  pinning a session, write-once, to a harness that cannot run.

  **Every gate that says "not installed in this deployment" asks the declared set, never
  `AgentInfo.installed`.** They agree wherever an image build wrote a report, and differ
  exactly where none did and the flag is a `which` probe. Refusing a *turn* is far
  stronger than greying a picker row — all `installed` drove before — and a probe miss
  does not support the claim the message makes: an injected agent factory, a local-mode
  in-process adapter, or a `$PATH` that differs at spawn time all probe as absent and run
  fine. CI found this the direct way: the first cut read `installed`, and every dispatch
  integration test 401'd on a runner with no agent CLIs on `$PATH`. The picker's own
  filter still reads `installed`, which is the long-standing behaviour for a harness that
  cannot be found.
- **"Appears nowhere in the picker" was a real UI change, not a consequence.** An
  uninstalled harness used to render as a group header tagged *not installed* over a list
  of disabled rows. That treatment is right for *installed but unauthenticated* — which is
  actionable, and stays — and wrong for a harness the deployment does not have. Onboarding
  had the same shape and no longer offers to connect an account for a harness that cannot
  use it.
- **Session naming needed an explicit skip.** It shells out to the orchestrator's own CLI,
  so on an install without that harness it would spawn a missing binary and read the
  failure back out of stderr. `null` already means "keep the placeholder title", so the
  skip changes nothing around it.
- **The set is not enforced across the two images at runtime, and the honest statement of
  why is narrower than the first draft's.** Both builds take the same arg from one place
  (the compose files' `${SHIPIT_HARNESSES:-claude,codex}`, fed by the operator env file),
  so the two *images* cannot disagree within a deploy. **Containers can**: a deploy
  deliberately does not kill session workers (docs/113), and `getContainerFreshness`
  compares `SHIPIT_BUILD_ID` — the git SHA — so a redeploy that changes only
  `SHIPIT_HARNESSES` leaves adopted workers looking current and they are never rotated for
  it. Adding a harness therefore offers it, in already-resident sessions, on a container
  whose image predates it; the turn fails on the missing binary until that container
  rotates. New sessions are unaffected (new container, new image), and removing a harness
  is safe in the same window because the turn-admission gate refuses it first.

  Left as a documented window rather than fixed, because fixing it means either killing
  live sessions on a redeploy — the thing docs/113 exists to stop — or making the harness
  set a second staleness axis for a change that is rare, loud when it bites, and
  self-healing on the next container rotation. Cross-backend review found this; the first
  draft claimed the images "cannot disagree" and left the container case unsaid.

## Retiring the `ProviderAccount` projection (planning#342)

Phase 2 said "phase 3 deletes the projection" and phase 3 did not, for a reason
worth recording because it generalizes: **each phase re-keyed what it *read*, not
what the router is *built from*.** Phase 3 re-keyed eligibility, phase 5 the
failure policy, phase 6 the quota map — none of them needed the account walk
itself in route terms to meet its own requirement, so the projection survived as
the seam between the new credential model and the old routing model. A
compatibility layer that nothing owns is how a temporary seam becomes permanent,
which is why it was tracked on its own rather than left to the next phase to
notice.

What the retirement actually is:

- **The router splits into two axes instead of one.** `serviceId: string` for
  every question about a credential *row* — which exist, their order, which one
  a turn takes, benching, cutoffs, status — and `provider: AgentId` for the
  places a *harness* is genuinely the subject: the on-disk credential root
  (`provider-accounts/<harness>/<id>`, unchanged so no install's credentials
  move) and "does this harness have any credential of its own vendor's".
  `accountServiceForHarness` is the one named conversion between them.

  The login flow was on that list and is not any more: `AgentAuthManager` is now
  keyed by `LoginIntegrationId`, so a sign-in names a vendor rather than a CLI,
  and a completed one fans out to every harness it serves via
  `refreshAuthForLogin`. See `harnessesForLoginIntegration` for what stayed
  harness-keyed and why.
- **The projection and `ProviderAccount` are gone**, along with the four
  `CredentialStore` methods and the two adapters. The only thing that still needs
  the old shape is the one-time read of the frozen `providerAccounts` blob, which
  is a *disk format* and now says so: a private `LegacyProviderAccountRow` in
  `credential-store.ts` rather than a live domain type.
- **The wire keeps its names and changes its type.** `providerAccounts`,
  `provider_accounts` and `/api/provider-accounts/:provider/...` are the
  *account-connection UI's* vocabulary, and `via: "account"` is a concept this
  feature kept; what it removed was the storage/routing type. So the payload is
  `CredentialRoute[]` and the endpoints are untouched.

**Two things a reader should not have to re-derive.**

- **The hazard the compiler cannot catch.** `serviceId` and `AgentId` are both
  bare strings, so `list("claude")` compiles and answers `[]` — which reads as
  "no accounts connected", an ordinary state. The `AgentId` union protects the
  harness direction; the service direction is protected by a guard test and by
  routing every `AgentId`-holding caller through one conversion rather than an
  improvised `nativeServiceForHarness(...) ?? something` per site.
- **One deliberate behaviour difference**, in `selectRouteForSelection`: the
  account walk is now asked about `selection.serviceId` rather than the harness's
  native service. They coincide everywhere the picker can reach, and diverge only
  for a session row naming, say, `(anthropic, sub)` while pinned to the Codex
  harness — which the picker never offers, and where the old answer (walk
  OpenAI's accounts) was wrong anyway.

  **State the reason precisely, because the obvious version of it is wrong.**
  `acceptsAccount` does *not* rule the divergent state out: it asks whether the
  harness can carry an account-delivered credential at all, and Codex can. The
  equality holds because of the **catalogue**: only `anthropic:sub` and
  `openai:sub` declare an account-delivered credential, and each one's models are
  carried only by its own harness, so every picker-reachable account selection
  has `selection.serviceId === nativeServiceForHarness(harnessId)`. That is a
  property of today's rows, not of the code — a future service with an
  account-delivered subscription a second harness can carry breaks it. Cross-
  backend review caught the loose phrasing; `service-routing.test.ts` pins the
  axis on the divergent pair, so the choice cannot be quietly reverted.

**What this does *not* do, deliberately.** There are still two quota-aware walks
— the account one here and `stringSelectionFor`'s in `service-routing.ts` — and
unifying them is a separate change, because today they differ in ways that are
only *coincidentally* equal: the string walk consults no limits snapshot and no
cutoffs, which matches the account walk exactly as long as nothing reports quota
for a string credential (planning#339 is what changes that), and a mixed group
would interleave differently than today's "accounts first, then strings". Both
walks now speak `CredentialRoute` and share `orderForSelectionMode`, so the
unification is a small change rather than a translation — but it is a behaviour
change, and this one was not.

## GLM's quota reader (planning#339)

The last piece of phase 2, deferred until phase 6 had somewhere for it to report
into. `zai-plan-usage` had been a **declared id with nothing behind it** since
phase 1: the catalogue named it on GLM's subscription, the type made naming one
mandatory, and no code anywhere selected on it. GLM's rows rendered no usage
bar, and phase 5 withheld their failover cutoffs on the grounds that a cutoff is
a percentage of a number nobody reports.

`orchestrator/limits/zai-limits-provider.ts` is the reader. Four things about it
are decisions rather than mechanics.

**It is the first `LimitsProvider` that is not a harness's.** The two shipped
readers are built in `agents/index.ts`, keyed by `AgentId`, because each belongs
to a CLI's own vendor. GLM's plan belongs to a *service*: it is authenticated by
a pasted key and delivered to whichever harness carries it, so there is no agent
id to file it under. Phase 6 is what made that a non-problem — a provider
declares its own `(serviceId, billingMode)` and `bootstrap-managers.ts` indexes
the registry on that — so registration is the same seam, reached from a
different construction site.

**It is pulled, not pushed.** Both first-party readers are event-fed: their
numbers arrive on the agent's stream during a turn. Nothing pushes GLM's, so
`refreshNow()` fetches `GET https://api.z.ai/api/monitor/usage/quota/limit` with
the route's key as a bearer token, and `fetch()` returns what was last pulled.
That makes the two moments an account-backed subscription gets for free —
a baseline at sign-in, a cache clear at sign-out — things a pasted key has to be
given explicitly, which is what the `refreshQuotaForCredential` /
`forgetQuotaForCredential` helpers in `api-routes-bootstrap.ts` are: a seed when
a credential is added and at boot, a re-read when its secret is replaced, and a
forget when it is removed. `setRateLimits()` is still honoured, because a
reading that does arrive is a real one, but nothing is known to produce one.

**The contract is undocumented, and measuring it invalidated every guess.** The
endpoint is internal to Z.ai's own subscription UI. It was first written against
community-reported field names, then exercised against a real coding-plan key —
and the measurement is the most useful thing in the file, because the guesses
were not merely incomplete, they were **backwards**:

| Field | Guessed | Measured |
|---|---|---|
| `usage` | the consumed percentage | the **allowance** (2000, 10000) |
| consumption | — | `usage - remaining` |
| `currentValue` | — | **lags**; stayed 0 while `remaining` moved 2000 → 1999 |
| `percentage` | the number to use | reported `1` for a true `0.05` |
| a missing reset | malformed | **no window is open yet** — it appears on first use |
| `unit` / `number` | an opaque discriminator | the window LENGTH: `unit: 3` is hours |
| plan tier | not present | `data.level` (`"lite"`) |

A reader that took `usage` as a percentage would have reported this plan at
**100% spent while it sat at 0.05%**. What stopped it was the rule that an
out-of-range value is a misread field rather than something to clamp: 2000 is
not a percentage, so the entry was discarded and the pill stayed empty. That is
the fail-closed design doing exactly the job it was written for, on the first
real payload it ever saw — and it is why the rule survives the measurement
rather than being relaxed by it.

So consumption is now derived from `usage - remaining` (exact, and
self-consistent across both entries, which `currentValue` is not), and
`percentage` is kept only as a fallback for a payload that omits `remaining`.

**`unit: 3` is hours, and that is the only unit this reader claims to know.** It
was established, not assumed: an entry declaring `number: 5` produced a reset
exactly 5.00 hours after the request that opened the window. Knowing the
declared length is what lets the 5-hour window carry a real `startedAt`, so the
badge's elapsed marker stops depending on a constant Z.ai never agreed to. The
long window (`unit: 6, number: 1`) is deliberately **not** in the unit table:
its reset sat 4.85 days out and did not move between probes, which fits a
monthly cycle as readily as a weekly one. It is placed by reset horizon instead
and carries no `startedAt` — less precise, and unable to be wrong in the
particular way a guessed length would be. **The one open question this leaves**
is the label: `SubscriptionLimits` has only `session` and `weekly` slots, so a
monthly allowance would render under a "7d" heading. The number and the
countdown are right either way; only the heading is at risk.

**Switching it on was one line, and that is the load-bearing part.** Adding
`zai-plan-usage` to `IMPLEMENTED_QUOTA_INTEGRATIONS` gave GLM's rows a usage
read-out *and* their failover cutoffs, with no change to `ServicesPanel`,
`CredentialRouting` or the string-credential walk in `service-routing.ts` — all
three already asked `modeReportsQuota` rather than naming a service. Phase 5's
deferred item closed by the reader existing, which is the shape the deferral
predicted.

Two smaller things travelled with it. `subQuotaRefreshable` in the catalogue
replaces the `serviceId === "anthropic"` written out by hand at **three** client
call sites to decide whether a pill gets a refresh button — a narrower question
than `modeReportsQuota`, because Codex's numbers can only ever be received. And
the refresh button's failure copy now names the service it actually called,
rather than telling a GLM user that Anthropic rate-limited them.

**Verified end-to-end** against a live coding-plan key: the reader returns the
5-hour window at its exact fraction with a derived `startedAt`, the long window,
and `plan: "Lite"`. The test fixture is that payload transcribed verbatim rather
than paraphrased — a fixture that "looks about right" would re-admit precisely
the misreadings the real shape caused.

## The default for a session that never picked a model (planning#353)

A late instance of the same pattern as planning#342 above: each phase re-keyed
what it *read*, and one branch kept an older answer whose premise this feature
had already removed.

`selectRouteForSelection`'s `!selection || !mode` branch asked
`selectAccountForTurn(accountServiceForHarness(harnessId))` — the harness's own
vendor — and justified it as "the only service a session with no selection could
ever have meant". True before this feature; false the moment a harness could run
another vendor's models. On an install whose only credential is a DeepSeek key,
a GLM plan or an OpenRouter key, the harness's own vendor is precisely the
service with no credential, so every selection-less turn died `auth_required`
while the composer displayed a runnable model. Sessions reach that state
routinely: a headless create, a warm session opened and typed into, and a row
whose model id the catalogue has since dropped (`setModel` nulls the service and
mode for an unknown id, deliberately).

Phase 7 had already solved the identical problem for background work, and its
docstring names this exact install: a fixed default "would point at a vendor the
install may have no credential for, which is exactly the install this feature
exists to create (a user whose only credential is a DeepSeek key)".

**Where the fix lives is the interesting part.** The obvious move — derive the
default inside the `!selection` branch — is half a fix. A turn has *two*
independent readers of the session's selection: `selectTurnRoute`
(`session-agent-env.ts`) and `buildAgentRunParams`, which rebuilds the triple
from the row to produce `serviceRouting` (endpoint + credential) and `--model`.
Deriving in the first alone pins a DeepSeek route onto a spawn still shaped for
Anthropic — a worse failure than the one being fixed, because it also
mis-attributes. Deriving in both is one rule written twice.

So `prepareSessionAgentEnvironment` **settles the row** instead: when a turn
starts and the row names no real catalogue mode, it writes
`firstEligibleSelectionForHarness(agentId, …)` via `setModelSelection` before
anything reads it. That restores the invariant `session-agent-run-params.ts`
already states — "the row is the authoritative answer to what this session will
run next" — rather than adding a second source beside it, and everything
downstream (shaping, `--model`, attribution, the picker) reads the field it
already read. It only ever fills a gap, and only on a turn: a row naming a real
mode is untouched, and a warm-up stays account-neutral.

`firstEligibleSelectionForHarness` is `eligibleEntriesForHarness(...)[0]`. That
list *is* the picker's ordering — the catalogue join for the harness, narrowed
to modes holding a credential it can carry — so "the first model this install
can run" and "the first model the picker would offer" cannot become two rules.
It returns `undefined` when the harness can run nothing (a Codex session on a
DeepSeek-only install: Codex speaks only `openai-responses`), which correctly
leaves `auth_required` as the honest answer.

**And it writes only when the derived service is not the harness's own vendor**
— the guard that keeps the change a strict no-op wherever the old fallback
already worked. Cross-agent review found why it is needed, and the reason is
sharper than "be conservative": if the first eligible model belongs to the
native vendor, the old question reaches the same credential, so writing changes
nothing about *routing* and plenty about the *spawn*. A previously-unshaped
first-party turn would start being shaped — gaining an explicit `--model` it did
not send before, and, for `anthropic:sub`, moving the secret out of
`ANTHROPIC_AUTH_TOKEN` into `ANTHROPIC_API_KEY`, which delivers an OAuth bearer
token as an `x-api-key` header. That last one is a real catalogue defect
(planning#354: Anthropic's subscription has no `targetOverride` where GLM's
coding plan does), and this fix deliberately routes around it rather than
depending on it. The write is confined to the case the old answer got wrong: a
harness whose own vendor this install cannot authenticate.

A write is also announced. `model_selection_changed` carries it to the viewers
with a `notice`, for the same reason `set_model` sends one after persisting: the
composer derives its display from live state and never re-reads the row, so a
silent server-side write leaves every viewer showing a model the turn is not
using.

The `!selection` branch itself is left in place, now reachable only from the
genuinely empty case, from a first-party install (where it remains correct), and
from callers that always supply a selection. Its comment records that it must
not be restored as a *general* session default.

Two limits worth stating rather than discovering later. Turn-start attribution
(`wireAgentListeners`) captures the selection before env-prep runs, so a derived
turn has none at capture time and relies on the result-time re-read of the row;
and the resident-reuse decision also reads the row first, so it cannot see a
write that has not happened yet. Neither is reachable under the guard — a
selection-less resident on such an install could never have authenticated in the
first place — but both would need attention if the write were ever widened to
the first-party path.

## The composer's harness display, and which session a composer is bound to

The composer is rendered on three surfaces, and only two of them have a session of their own:
the in-session composer, the new-session route, and Quick Capture. All three read the **same
global session store**, so a picker that resolves `sessions.find(id === store.sessionId)`
unconditionally describes whichever session happens to be active — including from a composer
that will never send to it. Quick Capture over a Codex session showed "Codex" while it went on
to create a Claude session from the saved seed. Pre-existing: the pre-split picker did the
same, and phase 3 recorded it rather than fixing it.

**What the picker shows with no session bound is the harness that session will actually be
created on**, and there is exactly one rule for that — `agentIdForModel(savedModel) ??
savedAgentId`, the model being the single source of truth so a stale `vibe-agent-id` cannot
out-vote it (docs/142 Problem C). It was duplicated in `useSessionWebSocket` and Quick Capture
and is now `newSessionAgentId` (`client/utils/new-session-agent.ts`), read by the creator and
the display alike. The rejected alternative was the ui store's `activeAgentId`: it is *synced
to the connected session* by `useConnectionSync`, deliberately, so it answers "what is the
session I am looking at running on" — the wrong question here, and the contaminated value that
made the App-side new-session composer wrong for the same reason.

**`hasActiveSession` is the wrong gate, and this is the part worth remembering.** The
new-session route claims a warm session up front and talks to it (`set_agent` goes over its
socket, and the connect URL seeds it), so it is `hasActiveSession: false` and **bound** at the
same time — gating on that flag would have stopped the display following a harness the user
picked there. The gate is the narrower "is a session bound at all", passed as
`seedFromHistory` (`!sessionId` in `MessageInput`), which is the shape and the name
`ReasoningSelector` already used for the same distinction.

**A bound session is not necessarily a *visible* one, and that is where the same bug survived
its first fix.** `SessionManager.list()` filters `warm = 0`, so the claimed warm session is
bound but absent from the store's `sessions` — the composer has a session it cannot look up,
and falls back to `activeAgentId`. That fallback has to stay: it is the only channel carrying
an explicit harness pick made on this route, which the seed cannot carry when the saved model
belongs to the other harness (`newSessionAgentId` puts the model first, by docs/142). So the
fix is to keep the fallback *truthful* rather than to remove it — `useUiStore.reset()`, which
`resetSessionState` runs on exactly the "no session behind it any more" transition, returns
`activeAgentId` to `newSessionAgentId`. Without that the route displayed the seeded harness
before the claim landed and then flipped to the previous session's, while still creating the
seeded one. Found by the cross-backend review; the first version of this fix shipped the flip.

**`modelInfo` is global too, and scoping it by harness is not enough.** The live model is
scoped to the displayed agent, which was sufficient while every composer had a session. Quick
Capture is handed the *background* session's `modelInfo`, so when that session runs the seeded
harness the id passes the agent check and outranks the seed — the overlay showed the background
session's model while creating with the saved one. A session that does not exist yet has no
live model, so `seedFromHistory` drops it outright.

One wart is left as pre-existing and out of scope: in Quick Capture a harness pick alone does
not move the display when the saved model belongs to the other harness — because the overlay
derives the agent it *sends* from the model too (docs/166). The display is now honest about
that rather than contradicting it, which is the change; making the pick move the model is a
behaviour change and not one this took.

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

**Both halves were later measured, and they did not answer the same way.** OpenRouter's
Anthropic-Messages surface is real and its rows carry it; OpenRouter also serves the
Responses API (2026-08-15, planning#391), so the crossing is no longer hypothetical — but it
is a *DeepSeek* model that crosses, both of them, each measured against the live endpoint.
Anthropic publishes no Responses API for the gateway to pass through, and no run has
exercised an Anthropic id over it, so the striking illustration remains undeclared for want
of evidence rather than for want of a mechanism. The design point is unchanged either way: what forbids the crossing is a missing
style on a row, never a special case in the eligibility check.

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

**Two selectors, not one: harness and model separate** ([prototype](./mockup-picker.html);
shipped in phase 3 as `ModelPicker.tsx`'s `HarnessSelector` and `ModelSelector`).
`ModelAgentSelector` was a single dropdown whose group headers were *harnesses*, because
harness and provider were the same thing. Once they are separated, that grouping is wrong
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
  also offers that exact `(service, billing mode, model)` triple — which is what carries
  `deepseek-v4-flash` through a Claude Code → Codex switch now that DeepSeek serves the
  Responses API as well ([`catalogue.md`](./catalogue.md), dated 2026-08-13) —
  and otherwise move to the first eligible model and say so.
  Landing somewhere else silently would contradict req 11; refusing the switch would make an
  enabled control lie. The combined picker never had this case, because there the harness and
  model moved together by construction. **Phase 4 shipped this** as
  `conformSelectionToAgent` — and note the test is the *triple*, not the model id: two
  harnesses can offer the same id while only one reaches it through the service the session
  is pinned to.

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
comment in the picker (now `ModelPicker.tsx`) already names it as such, having moved
live-model display there once. Service and billing kind join it there. Attribution is then two places with
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
which this feature does not touch. Phase 9 shipped it as a single `SHIPIT_HARNESSES` list
rather than a boolean per CLI, and kept the report path — see the phase note above.

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

### One card *component* — and no per-vendor tabs at all

The paragraphs above say "one card per `(service, billing mode)`", and phase 2 shipped that
grouping — but not with one card *component*. A string-delivered credential got a bordered
card inside this list; an account-backed subscription got `ProviderAccountsCard`, rendered
**outside** it: no border, its own header, its own routing controls, and titled after the
*harness* vendor ("Claude subscriptions") rather than the service. Two components, two visual
languages, one list. That is what the [UI audit](./ui-audit.md) records as **D2**, and what
Nik saw as "elements from the old system and from the new system".

The fix is structural rather than cosmetic, and it deletes more than it adds:

- **`ServiceCard`** owns the chrome for every card alike — border, avatar, service name,
  billing-mode pill, credential-count pill, the model chips, and a shaded routing band with
  its own heading (D7, D9). It owns no credential logic; which rows go inside is the caller's.
  It had a header-action slot too, until req 17 (below) left nothing to put in it.
- **`ProviderAccountsCard` became `ProviderAccountRows`** — a *body*, not a card. Its header,
  its status dot, its routing controls and its API-key disclosure all left with the card
  chrome. Its "Add account" became `AddAccountButton` in the card's header slot, and then —
  req 17 — stopped being a button at all.
- **`CredentialRouting`** holds the selection-mode radios and the failover cutoffs, keyed by
  `(service, billing mode)`. There had been **two** selection-mode controls writing the same
  stored setting — a per-harness one on the accounts card and a per-`(service, mode)` one on
  the string card, which for Anthropic's subscription is the identical key. Only one could
  ever be on screen, so the duplication was invisible until the two cards became one.
- **A mode that takes both shapes at once** — Anthropic's subscription accepts an OAuth
  account *and* an env-supplied token — is now ONE card with both bodies stacked, where it
  used to be two cards for one `(service, mode)`.

**The status dot went rather than moved** (D5). It was green whenever the *harness* had any
runnable model, so it read green above the words "No Claude subscription connected yet" as
soon as an unrelated DeepSeek key existed. The mock has no per-card dot and the card's own
rows already state each credential's status, so there was nothing for a corrected dot to add.

**And there are no per-vendor Settings tabs.** The `Agent` group led the sidebar with `Claude`
and `Codex`, Settings opened on `agent-claude`, and each tab held exactly
`ProviderAccountsCard` + `SubAgentDefaultsSection`. Once the first is one of the Services
cards, the tab is a second editor for one fact — its "Use an API key instead" disclosure wrote
through to the very credential the Services add-flow writes. Both tabs are deleted, Services
leads the (now flat) list, and Services is the tab Settings opens on (D1).

**Installed harnesses are named at the foot of the panel (2026-08-11).** A read-only list —
each installed harness, with a dot and, when it has none, "no model it can run yet". It exists
because eligibility (req 8) is a *join*: a stored credential is not runnable until an installed
harness can carry it, so a screen that collects credentials and says nothing about harnesses
leaves a user with a working key and a disabled composer nothing to read. The list is a
statement, not a control — harnesses are installed in the image, not from the browser.

This is **not** D5's status dot coming back. That dot was on a *service* card and read
`hasRunnableModels`, a harness-wide flag, so it went green above "No Claude subscription
connected yet" as soon as an unrelated DeepSeek key existed. Here the same flag is on the
harness row it actually describes, which is the axis it was always measuring.

The **API-key disclosure** (`onApiKey` / `onSetAgentEnv`) went with them, reachable instead as
*Add a service → Anthropic → API key*, which is the same credential route. One asymmetry
survives that move and is worth stating rather than discovering: `setApiKey` rejected anything
not starting with `sk-ant-`, and the generic route endpoint the add-flow posts to does not, so
a mistyped or wrong-vendor key is now stored as `ready` and fails at the first turn instead of
at the paste. The audit already recorded that gap for every *other* service in the catalogue;
removing the disclosure widens it to Anthropic rather than creating it. Closing it properly
means a per-mode credential shape in the catalogue, which is not this pass.

**The "Clear saved credentials" escape hatch stayed, moved onto the account rows** — a first
draft dropped it on the reasoning that a row's **Disconnect** does the same job, and
cross-backend review showed that is false. Disconnect deletes ONE account;
`DELETE /api/auth/api-key` is deliberately provider-wide (docs/150-multiple-provider-subscriptions req 19), clearing every
account's credentials *and* the singleton pre-account path where a legacy install's unscoped
OAuth tokens sit with no row to reach them from. Its gate did change: it hung off
`agent.hasRunnableModels`, the same harness-wide flag that made the status dot lie, and now
reads "rows exist and none of them can authenticate".

**A mode holding both delivery shapes is one card but not one routing pool.** Anthropic's
subscription can carry OAuth accounts *and* an env-supplied token, and phase 5 decided an
exhausted account walk is returned unchanged rather than falling through to that token
(`service-routing.ts`). So the routing band counts and names only the accounts, and the token
gets no order controls — `reorderCredentialRoutes` requires every route of the
`(service, mode)` exactly once, so a list of just the string ids is a 400, and there is
nothing to order anyway. The token's row says what it is instead. Also cross-backend review.

`SubAgentDefaultsSection` is left unrendered rather than deleted: it is docs/217 work, the
design has no per-harness surface left to host it (D16), and docs/261 phase 2 removes the
feature outright. Deleting it here would collide with that work.

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

Review confirmed this is the right axis and that the existing code already half-drew
it — but found the gate applied in **one** of the two places that need it. Account
benching checked the route kind and bailed for a reserved route
(`bootstrap-managers.ts`), while the same-turn quota retry had **no billing-mode gate at
all**: it fired whenever exhaustion was detected, from the error object or, when there was
none, from the turn's own text (`turn-executor.ts`). A key-authenticated service answering
"quota exceeded" was therefore retried once on the same bad key, which is exactly what
req 12 forbids. **Phase 5 put the gate on both**, and on the billing mode rather than on
how the credential is shaped — `credential-failure-policy.ts` is the single function they
share, so the branch cannot be drawn differently in two places. Benching itself widened at
the same time: a subscription is not always an account, so
`markSessionAccountExhausted` now stamps a string-delivered subscription credential too,
and still refuses a metered key.

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

Four kinds of site, all reading `AgentInfo.authConfigured` — since renamed
`hasRunnableModels` — or its derivatives:

- **Availability** — `AgentRegistry.available()` (`agent-registry.ts:401`).
- **Selection** — HTTP (`services/settings.ts:323`), WS (`route-registry.ts:1164`), the
  picker's disabled state (now `ModelPicker.tsx`), the client's automatic redirect to
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

**What shipped is the rename, not the split.** Phase 3 found the two questions are not
separable at these sites after all: every one of them wants "can this harness take a turn
here", which is `installed` **and** "has a runnable model" — so a single field with the honest
name (`hasRunnableModels`) says it, and `available()` stays the conjunction. Onboarding did
move to the credential question, as described above.

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
**Phase 4 shipped that message** (`describeSelectionMove`, delivered as a toast on
`model_selection_changed`); until then all three moved silently.

**Mid-session model switching** (req 4) is not a new mechanism: the model is already per-turn
data — a spawn flag for Claude Code, a `turn/start` field for Codex — so both shipped
harnesses support it unconditionally. Req 4's "as far as that harness supports it" is
therefore carried by **no flag today**, deliberately: a capability with one possible value is
noise, and `AgentCapabilities` gains one only if a candidate turns up that fixes its model at
process start. A switch that
crosses *services* additionally re-resolves the credential and base URL for the next spawn.
**Phase 4 is the interaction on top of the rest of this section** — `model-switch.ts` for what
a switch may do to a live session, and `model_selection_changed` for what the user is told.

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

Session naming is *almost* unaffected — it already runs a CLI (`session-namer.ts`) and mostly
needs the resolved triple threaded through. The one thing that shape hid is the spend: it
returned a string, so recording what a metered naming run cost also meant asking the CLI for
its telemetry. See the phase-7 notes above.

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

> **Superseded on 2026-08-13 — the setting now has one state.** Everything above about
> *unset* still describes the resolver's fallback, but it is no longer a state the user can
> be in: `seedNonTurnModel` writes the first eligible model the first time the install can
> run something, and only the user changes it after that. See
> *[One state, because the second one could not be named](#one-state-because-the-second-one-could-not-be-named)*.
> The paragraph is kept because the first-eligible **rule** it defines is what gets written.

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

There was precedent to copy rather than a mechanism to invent: `normalizeCodexModelId`
(then at `agent-registry.ts:141`) already did exactly this for one model, mapping the retired
`gpt-5.6` slug onto `gpt-5.6-sol` "at the boundary before Codex turns so legacy sessions
run the intended Sol model". Req 13 generalizes that one-off shim from a hardcoded
per-`AgentId` special case into a per-service catalogue field. Phase 8 **subsumed** it: the
shim is gone and there is one mechanism rather than two — but *not* at the same boundary.
Resolution moved up to where the service and billing mode are known, because an id alone
cannot say whose retirement applies once two services offer the same one (req 5); see the
phase-8 notes above.

**The remap writes through to the session's stored selection; it is not a read-time
normalization.** The precedent this generalizes, `normalizeCodexModelId`, rewrites the model
only at the turn boundary (`agent-registry.ts:136`) and leaves the persisted row alone — and
the picker deliberately gives the *persisted* model precedence over the live one the CLI
reports (now `ModelPicker.tsx`'s `ModelSelector`). Transcribing the shim's shape would therefore run the
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
- The **401 misfire** is fixed by *deleting* behavior, not adding it (req 12).
  `AUTH_ERROR_PATTERNS` (`process.ts`) catches auth-shaped text and drove ShipIt's
  own re-auth flow, which for an API-keyed service is both wrong and unfixable.
  **Phase 5 deleted the recovery rather than the detection**, and did it in the
  orchestrator — see that phase's notes for why the gate is not at
  `AUTH_ERROR_PATTERNS` itself. The turn stops and says so, naming the service.

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

## One way in — the sign-in is a step of the add-flow (req 17)

**The card has no way to add anything, and the dialog signs the user in.** Both halves of
that landed together, because they are one change: pressing *Sign in* in step 3 calls
`createAccountAndStartLogin`, and the provider's challenge renders in the dialog through
`AccountChallenge` — the **same component** the account row renders, never a copy of it,
which is docs/150-multiple-provider-subscriptions req 16 the requirement rather than the aspiration.

**What it deleted is the interesting part.** The hand-off ("Continue to sign in" → close →
reveal the card → press *Add account*) needed somewhere for the button to live before any
credential existed, which is what `revealedServiceModes` was: a UI-store list of
`(service, mode)` keys with a card each. Every other reason a card is on screen has a way
out — remove the key, disconnect the account, dismiss the notice — and a reveal had none, so
choosing OpenAI → Subscription and stopping left a service listed with nothing in it that the
user could not remove. Deleting the hand-off deletes the reveal, the store slice, the
`AddAccountButton`, the `AddCredentialButton` ("Add another"), and `ServiceCard`'s
header-action slot. The card's list of what a card can be is back to three clauses, all
reversible.

**The dialog hosts the sign-in; it does not own it.** `POST /api/provider-accounts` creates
the row *before* the login finishes, and the login is a live process on the provider's side.
Three consequences, each a decision:

- **Success is read off the row**, not awaited: `status === "ready"`, which arrives on the
  `provider_accounts` broadcast. So the last step becomes a *Connected* line with **Done**,
  which is the confirmation, and needs no effect and no polling. It also survives a reload
  mid-challenge, because the row does.
- **Leaving abandons, however you leave.** *Cancel*, Esc, the backdrop and the close button
  all route through one handler: the login is cancelled and the account deleted
  (`abandonAccount`, cancel-then-delete, both best-effort), so nothing unfinished is ever
  listed. The first cut split them — Cancel abandoned, a dismissal kept the attempt for the
  card to finish, on the grounds that the provider may already have authorised the code —
  and the human rejected that against the requirement it quietly contradicted: "unless you
  pressed Escape" is not a clause anybody would predict, and one press to start again is
  cheaper than a listed service nobody asked for (receipt, 2026-08-11). A *connected*
  account is not an unfinished attempt, so Done and Esc are the same harmless exit there.
- **One sign-in per provider** is the server's rule (409). The dialog states it before the
  click — `signInBlockedReason`, shared with the row's own `blockedBy` — rather than after.
- **An attempt is not a credential, and the panel lists credentials.** The account exists
  the moment the sign-in starts — the login needs a row to hang on — and it is deleted again
  if the user leaves. So everything that lists accounts was showing it: a card appearing
  behind the open modal with a phantom `authenticating` row, the provider's code on screen
  **twice** (the row hosts the same shared `AccountChallenge`; on Anthropic that is two
  paste-code inputs of which one submits), and then the card vanishing when the user backed
  out. Two flickers around a service that was never added.

  The first fix tracked which account the dialog owned and hid that one. It was wrong in
  kind: two sources of truth — the store's account list and the panel's idea of ownership —
  updated at different moments, so the seams flickered exactly where the timings differed
  (the account landed in the store before the panel learned whose it was; the panel forgot
  whose it was before the DELETE landed). **`isUnconnectedAttempt` derives the answer from
  the account itself**, so there is no second thing to lag: `useProviderAccounts` filters
  attempts out, every card reads its rows, its count and its routing from that one list, and
  the panel's `configured` uses the same predicate. A MutationObserver over the whole flow
  records zero appearances.

  **Both of its clauses are load-bearing**, and each covers the other's hole — `externalId`
  is the server's own "created by the click, nothing in it"
  (`provider-account-manager.ts:681`) but an unreadable identity **proceeds** by design
  (`provider-account-identity.ts:118`), so a connected account may have none; and the two
  pre-connect statuses would over-hide on their own, because `signOutAccount` puts a
  *connected* row back to `unavailable`. Full reasoning in the predicate's docstring.

  **Hiding can never strand a row**, which is what makes the residual case safe rather than
  merely unlikely. The dialog **adopts** an existing attempt instead of creating a second, so
  anything hidden is picked up by the next sign-in and ends as a credential or a deletion.
  That also fixed a trap the hiding created: a stranded attempt is `authenticating`, so the
  one-login-per-provider guard read it as somebody else's sign-in and disabled the only
  button that could recover it — citing a row the user could not see. The guard is measured
  against the attempt this flow would adopt, not against any in-flight login.

**What cross-backend review found, all of it on the paths where the sign-in does *not* simply
work:**

- **A login that fails to START left an orphan the dialog could not abandon.** The account is
  created by one request and the login started by a second, and a single
  `createAccountAndStartLogin` awaited both before returning the id — so a CLI spawn failure
  or a 409 race threw *after* the row existed, leaving `signInAccountId` unset, *Cancel* with
  nothing to delete, and every retry creating another orphan. Split into `createAccount` +
  `startAccountLogin`, with the dialog taking the id between them. The user still presses once.
- **A challenge the provider REJECTED dead-ended.** `agent_auth_failed` clears
  `providerAccountAuths` and files the reason under `providerAccountAuthErrors`; the dialog
  read only the former, so `AccountChallenge` rendered nothing and *Sign in* was already
  hidden — the only retry left was the Connect button on the card *behind the modal*, which is
  the hand-off req 17 deletes, rebuilt by accident. There is now one **stalled** state (an
  account, no live challenge, not ready) carrying the provider's reason and a **Try again**
  that reuses the same account rather than creating a second.
- **Two tabs could claim each other's account.** The created row was inferred by diffing the
  returned list against a pre-request snapshot, and two dialogs starting the same provider at
  once each see both new rows — so one could go on to cancel and delete the other's attempt.
  The endpoint has always returned the `account` it created (`services/settings.ts:687`); the
  client now reads it, keeping the diff only as a fallback for older payloads.

**The cost, accepted knowingly:** adding a second account is a few clicks longer, since it
walks the whole flow. That is the trade recorded in req 17's receipt — rare action, permanent
surface.

### The mode click starts the sign-in (req 18)

With the hand-off gone, OpenAI → Subscription landed on a step that was **one sentence and
one button**: account-only, so no field, no choice, and the button only repeated the click
that had just been made. Choosing the mode now starts the login, so the step the user arrives
at is the one carrying the provider's code.

- **The condition is a catalogue fact, not a service name.** `signInIsTheWholeStep` asks
  whether the mode accepts an account **and nothing else**. Anthropic's subscription also
  takes an env-supplied token, so its step has a field to fill in and a sign-in that is one
  option among two — auto-starting there would pre-empt a real choice. Nothing about OpenAI
  is named anywhere.
- **Nothing auto-starts that would fail on arrival.** A missing harness or another login in
  flight leaves step 3 exactly as it was, saying so, with the button to retry once the way is
  clear — the same two guards the button had, checked before the start rather than after it.
- **Handlers read the store, not the last render.** The click that chooses the mode also
  starts its sign-in, and `service` / `billingMode` / the accounts hook are all a render
  behind at that moment. So `startSignIn` takes the pair as arguments (defaulting to state
  for the button) and both it and the guard read accounts through `providerAccountsOf(...)`
  on the store's current value. `adoptableAttempt` is one function for the same reason: the
  rule is now read at the render, at the start, and at the guard.
- **The gap before the code arrives had to be given a name.** The challenge is broadcast a
  moment after the login starts, and "an account, no live challenge, not ready" was the
  definition of *stalled* — so the interim said **"the sign-in stopped before the account
  connected"** about a sign-in that was starting normally. That was a flash behind a button
  press; as the landing screen it would be the first thing the user reads. A stopped attempt
  now has to have actually stopped — the requests done, and then a reason filed against it or
  a status that is no longer `authenticating` — and the interim says it is starting. The
  `startingSignIn` clause is not belt-and-braces: the row is created **before** the login is
  asked for and is created `unavailable`, so between the two requests it is neither
  authenticating nor failed. Measured in the dogfood instance, that was a 35 ms flash of the
  wrong sentence on the way to the code.

**What the independent review found, both on paths req 18 made easy to reach:**

- **Leaving while the account was still being created left it behind.** `cancel` can only
  abandon an id it has, and `createAccount` had not returned one yet — so Esc in that window
  closed the dialog over an account that appeared *after* the user had gone: hidden by
  `isUnconnectedAttempt`, holding the provider's single login slot, with nothing on screen to
  release it. That is req 17's "leaving is leaving" broken by a race, and it predates req 18
  — but starting the sign-in on the mode click is what turns "be quick after pressing Sign
  in" into a window anyone can hit. A `left` **ref** (not state — the answer must not be a
  render behind the question) is set by `cancel` and read by `startSignIn` after each await,
  so whichever of the two finishes last does the cleanup. Verified against the real API:
  escaping 5 ms into the create leaves zero rows server-side.
- **"Waiting for the code" cannot be told from "hung".** A login can reach `authenticating`
  and never produce a challenge — a CLI that stays alive saying nothing — and the tightened
  predicate correctly calls that *starting*, which hides the retry until the provider's own
  timeout (15 minutes on OpenAI). The review's fix kept the button through the wait as **Start
  again**; the human reversed it on sight: *"there should be no blue button like this at all
  … it should be always only Cancel."* While the flow runs itself the user is watching a box
  fill in, and a second button beside it is a live control they did not ask for, in the one
  place where a stray click restarts the login they are in the middle of. So the button is
  gone from the start, the wait and the challenge; it returns only when nothing is happening
  (stopped, or never started), and is **secondary** even then, since the step's own next
  action is no longer a button. A hung login is recovered the way everything else here is —
  close it and start again. A mode that also takes a key keeps its primary *Sign in*, because
  nothing auto-starts there.

**One panel per sign-in, and everything about the sign-in is in it.** Two providers, two
waits: OpenAI's device flow produces a code in about a third of a second, while Anthropic's is
a wizard ShipIt drives through the Claude CLI and runs about six seconds — long enough that a
pulse alone reads as *stuck* rather than as *working*.

- `AuthPanel` is the bordered box, and it is the same box in every state — waiting, challenge,
  failure. What changes as a login proceeds is its *contents*, never the page around it.
- `ChallengePlaceholder` fills it before the code lands, and takes a `shape`, because the box
  it stands in for differs: a code to read (98px) or a field to paste into (84px). One
  placeholder could only be right for one of them.
- **The narration is ShipIt's phase message**, in the slot the link will occupy ("Waiting for
  Claude CLI to print an authentication link"), with a pulse for the rest.
- **`ClaudeAuthOutput` — the whole buffer, collapsed — lives INSIDE the panel**, in both the
  waiting state and the challenge, so the arrival of the field moves nothing and there is one
  place carrying the sign-in. Its open/closed state is held in the settings store
  (`claudeAuthOutputOpen`, keyed by account) and **not** by the `<details>` element: the
  disclosure is rendered by two different components across one sign-in, so the element is
  destroyed and rebuilt at exactly the moment the code arrives. Uncontrolled, a buffer the user
  had open snapped shut under them and the panel jumped by the height of what they were
  reading. It is also 10px/14px mono rather than `--font-size-code` (13px) — that token is the
  size a chat code block reads at, and this is a diagnostic dump skimmed for one line — and it
  is **pinned to the newest line by `flex-col-reverse`**, not by a scroll effect: in a reversed
  column the scroll origin *is* the bottom, so a single growing child keeps its end in view
  while a reader who scrolls up stays where they put themselves. An effect assigning
  `scrollTop` on every append would fight them, and this codebase restricts effects anyway.
- **The buffer control is reserved from the panel's first frame**, empty and before there is an
  account to key it by. The CLI's first line lands a few frames after the login starts, so a
  disclosure that waits for it grew the panel by its own height *after* the panel had already
  appeared: measured, 302 → 395 → 419 across five frames — the second, smaller jump a user
  notices without being able to say what moved. The cost is a line reading "Claude CLI output"
  with no count for those frames; `ClaudeAuthOutput` therefore takes an **optional** account id.
- **The sign-in button goes with the click that presses it**, not with the state change a few
  frames later. `startingSignIn` is in its render test for that reason: the click turns the
  panel into the waiting box at once, and without it the blue button sat through the create
  request first — sampled per frame, one frame of blue, seven of nothing, then whatever came
  next, which reads as a control that hung around after the UI had moved on and was then
  swapped for a disabled *Save*. The rule is uniform across both kinds of mode now: while a
  sign-in is under way there is one button and it says Cancel.
- **Save appears with the field it saves.** It used to render from step 1, where there is
  nothing to save: permanently disabled, and — the mode being unknown that early — `primary`,
  so arriving at a mode with an account path *animated* it from blue to grey. Sampled per
  frame in the browser it is disabled the whole way through; only the colour moves, which
  reads exactly as a control that was available and was then taken away.

**Two rejected cuts got there first, and both are worth stating because they look reasonable
written down.** The first streamed the CLI's last three lines *below* the box: that put the
same output on screen twice — live there, and again inside the buffer — and needed
`authLogTail` (escape-stripping, redraw and spinner filtering, repeat collapsing) to be
readable at all, machinery that went with it. The second kept the collapsed buffer but left it
under the box, which still made the sign-in two places to look. The human called each on sight
from a screenshot; the third attempt was drawn as a mock-up and agreed *before* it was written,
which is the cheaper order for anything this visual.

**Waiting looks like what it is waiting for.** The step renders `ChallengePlaceholder` — the
same `CHALLENGE_BOX` shell as the real challenge, its lines drawn as a pulse — and the two
measure **98px** each, which is why the first bar is `h-4` rather than the `h-5` the link's
font size suggests (the link is inline, so its line box is 16). It is keyed off
`startingSignIn`, not off the account: keyed off the account it arrived one request late, so
the dialog opened short on a line of prose and then grew by the height of a panel. Measured
live, step 3 is 326px from its first frame and does not move when the code lands.

## The compact card (reqs 19, 20, 21)

Agreed from a mock-up before any of it was written (`/persist/services-compact-prototype.html`),
in the order the earlier round proved cheaper: draw it, agree it, then write it.

**The measurement that started it.** In the dogfood instance at 470px wide, the Anthropic
subscription card is **272px** and holds **39px** of credential; the DeepSeek key card is
**148px** and holds the same 39px. The rest is a description sentence (32px), an account
empty-state box (42px), a sentence about environment variables (48px) and a row of model-id
chips that grows with the catalogue. Compact, both cards are **~74px**: a header line and the
credential.

**What goes, and why each one is not merely verbose.**

- *"Connect one or more subscriptions. ShipIt fails over between them when one runs out."* and
  *"Metered — no quota to report, so this card shows no usage."* — neither says anything about
  *this* install. The failover rule is stated by the routing band, which appears only when
  there is something to route between; the metered fact is the **API key** pill.
- *"No {service} subscription connected. Add one with Add a service."* — printed **above a
  connected credential** of that same service whenever a card holds a supplied key and no
  account. Its docstring assumed the only way to reach it was a notice holding an empty card
  open, which stopped being true when the two delivery shapes became one card.
- *"Supplied by an environment variable, and used only while no account above is connected —
  ShipIt does not move onto it when the accounts run out."* — the first clause is **false**: the
  panel renders it for every `via: "string"` row on an account-backed card, and those rows are
  ordinary stored credentials with no recorded provenance. The rows that prompted the report
  were added by hand through the dialog. The second clause is true and is reqs 12/13; it does
  not need printing on every card to stay true.
- **The model-id chip row** — moved, not deleted. It becomes a `N models` control in the card's
  top-right corner naming them on hover (the human's placement).

**A row is `label · quota · ⋯`, whatever it holds.** The account row loses the permanently
mounted rename input (most of its 120px), the account UUID line, the status pill and three
ghost buttons; Rename / Reconnect / Disconnect move into the `⋯` menu.

**A healthy row says nothing about its health.** The mock-up first put a `StatusDot` on every
row — green for ready, amber otherwise — and it is the wrong instinct twice: a green dot on the
normal case is decoration on every row, restating what the absence of a problem already says,
and a hue alone is not a message a colour-blind user or a monochrome theme can read. So a ready
account shows nothing, and the states that need attention say so in words — *reconnect needed*,
*signing in…* — in `--color-warning` / `--color-error`. This is the same rule as the API-key
card's cut prose: do not spend a row on "nothing is wrong". A supplied-key row gets the same menu — Rename / Replace secret / Remove — so both row
types read the same. **Rename on a key row is new**: `PATCH /api/credential-routes/:id` has
always accepted a label patch, and nothing reaches it after the credential is added.

**Quota is `SubscriptionLimitPill`, not a new readout.** The header's pill is already keyed by
*route id*, already carries both windows, the elapsed-time marker, the staleness dimming and
Anthropic's refresh button. The one change it needs is `label` becoming optional: in the header
it must name its account, in a row the row already does. A key reports no quota, so a key row
has no pill and nothing explains the absence.

**The routing band appears when there is something to route between, and says nothing when there
is not.** One credential is the same absence as an API key's, and gets the same treatment: no
band, no disabled controls, no sentence. The audit's D8 cell was taken the other way for one
round — the mock-up's strip ("One account — nothing to route between yet. Add a second to choose
an order and a strategy.") was built, on the argument that a key card can *never* route while
this one names a capability the user can reach by doing one thing. The human rejected it on
sight in the dogfood instance, and the argument was the flaw: req 19 refuses prose that reads
the same on every install, and that distinction is a carve-out the requirement does not contain.
Adding a credential is what the panel's one "Add a service" button is for; a line per
single-credential service, on every visit to Settings, is not how it gets found. The receipt is
dated 2026-08-13 in `requirements.md`.

**The routing band's copy is kept — moved into tooltips, not rewritten and not dropped.** The
band's four strings are what make the choice answerable; compacting the band must not cost them.
Each one moves to the control it was already describing:

| String (verbatim, from `CredentialRouting.tsx`) | Where it goes |
|---|---|
| "How ShipIt picks between these accounts" | The segmented control's accessible name (`role="radiogroup"`) — **no tooltip**, see below |
| "Use in order" + "New sessions start on the first account with quota left. Best when they differ — a bigger plan first, a smaller one as backup." | Tooltip on the first segment, the option's name as its first line |
| "Spread across accounts" + "New sessions go to whichever account has been used least, so quota drains evenly. Best when they are equivalent." | Tooltip on the second segment, same shape |
| "Start new work on the next account once an account passes these. Accounts past their cutoff are still used when no other account is below one, so nothing is stranded." | Tooltip on the two cutoff fields |

Only one on-screen *label* shortens: the second segment reads **Spread evenly**, because it sits
in a 470px row beside the cutoffs. Its full name "Spread across accounts" leads its own tooltip,
so nothing is only available in the short form. `{noun}` still interpolates — "credential" on a
string-delivered mode, "account" on an account-backed one — exactly as today.

**The band title gets no tooltip, because it would have no trigger.** The first draft of this
table gave "How ShipIt picks between these accounts" a tooltip on the group. The two segments
fill the group's box, so every hover lands on a segment and the group's tooltip either never
opens or fights the one that does. A tooltip needs a hoverable trigger of its own, and inventing
one — an ⓘ beside the control — would add a pixel to save a sentence nobody asked to keep on
screen. So the string survives only as the control's accessible name: read on focus, costing
nothing.

`WithTooltip` (Radix) rather than a `title` attribute: it opens on keyboard focus as well as
hover, and a `title` is unreachable that way. One change to the primitive — `label` widens from
`string` to `ReactNode`, since two of these carry a bold first line. **A test asserts each of the
four strings is still reachable from the rendered band** — three as tooltip content, the fourth
as the group's accessible name — so a later tidy-up cannot quietly delete what the compaction
promised to keep.

**Ordering is drag-and-drop, and `Make primary` goes (req 21).** "Primary" was never a property.
`isPrimary` is stamped on read from position (`orderCredentialRoutes`, `index === 0`), every
writer stores `false`, and the endpoint behind the button is `reorder([this, …rest])`. Its only
live readers are the button, its disabled guard, and two badges; `backfillPriority` reads the
derived value once at boot and keeps working. So `POST /api/provider-accounts/:provider/:id/primary`,
`makePrimaryProviderAccount` and `ProviderAccountManager.makePrimary` are deleted with the
button — no other caller exists — and the field stays on the wire with no UI consumer.

**Reconnect opens the add-service dialog on its sign-in step, targeted at that account.** Today
it posts `/login` for the existing row and renders `AccountChallenge` inline in the card, which
returns `null` until the auth URL arrives — so between the click and the URL the row shows
nothing at all. That is the same "it looks stuck" gap the dialog's step 3 was built to close,
and the fix is to have one sign-in surface rather than a second, poorer copy: the waiting
skeleton, the CLI output buffer, the code field and the failure state all exist there already.
The row's inline challenge is deleted with it.

**It is the same component, entered differently — not a `ReconnectDialog`.** This is the whole
point of the change, so it is stated as a constraint rather than left to taste: there is exactly
**one** dialog in this panel, `AddServiceDialog`, with **one** mount site in `ServicesPanel`.
Everything reconnect needs is already there:

- `initialService` / `initialMode` skip steps 1 and 2, so the dialog opens on step 3.
- `signInAccountId` already names "the account this dialog's sign-in belongs to", re-read from
  the store every render. Reconnect seeds it with an **existing** id instead of one the dialog
  minted, and starts the login for it — the same `startAccountLogin` call `startSignIn` makes
  after its create.
- The title is already computed (`Add a service — {service.name}`), so the verb becomes a prop
  rather than a second dialog: *Reconnect Anthropic — Work plan*.

What must NOT happen: a copy of step 3 in the row, a second `Dialog` mounted from
`ProviderAccountRows`, or a "reconnect mode" branch that re-implements the panel. If a change
looks like it needs one of those, the seam is wrong — the dialog's step 3 is already parameterised
by `(service, mode, accountId)` and that is the entire input reconnect has.

**The one thing to pin with a test: cancelling a reconnect must not remove the account.** The
dialog abandons an attempt *it* created; a connected account is not an attempt
(`isUnconnectedAttempt` is false once it has an `externalId`), so cancel must leave it connected
and in the same position in the order. A second test asserts the panel renders exactly one
`add-service-dialog` testid whichever way it was opened, so a future reconnect surface cannot be
added beside it without turning the suite red.

**Environment-delivered credentials are adopted, not special-cased (req 20).** Today a
deployment's `ANTHROPIC_AUTH_TOKEN` produces no row: `listCredentialRoutes` returns stored rows
only, and `stringSelectionFor` reaches the variable solely as a last resort when nothing is
stored (`service-routing.ts`) — so it is invisible in Settings and cannot be renamed, reordered
or removed. It becomes an ordinary credential row at boot instead, which is what makes the
dogfood instance representative of a real install. Three things this has to get right, none of
them visible in the happy path:

- **Rotation.** The stored copy is written once. A deployment that changes the variable later
  has a stale copy, so adoption re-reads the variable on each boot and updates the secret of the
  row it created — unless the user has since replaced it by hand, which wins.
- **Deletion is a deletion.** The variable is still set after the user removes the row, so
  adoption must remember the removal rather than re-import it on the next boot.
- **The reserved route id.** `envRouteIdFor` maps the three legacy variables to ids that pinned
  session rows already hold (`claude-env-oauth`, `claude-api-key`, `codex-api-key`), so an
  adopted row keeps that id rather than minting a `cred_…` one, or every session pinned to it
  is orphaned.

**What building it changed about the design.** Four things, kept here rather
than quietly folded in, because each is a rule this document already stated and
the code implemented as a near-neighbour of itself.

- **Cancelling a reconnect must be asked of the ROW, not of the dialog's
  history.** The dialog abandoned whatever `signInAccountId` named, which was
  correct while every id it held was one it had minted. Seeding that field with
  an existing account — the whole of how reconnect works — made it a deletion of
  the user's working credential. `standDown` asks `isUnconnectedAttempt`, the
  same predicate the panel uses to decide what to list, and cancels the login
  either way; anything the panel hides, it cleans up. The guard test this
  section promised is what found it, before the code was ever run.
- **`mixedDelivery` and the routing pool read "can" for "does".** Both were
  `provider !== undefined && …` — "this mode can take an account" — where the
  question is "does it hold one". An account-capable mode holding two supplied
  credentials and no account was therefore treated as a mixed pair: no order
  between them, no routing band, and a header reading "2 accounts" over two
  things that are not accounts. It was unreachable until req 20, because the
  second string credential was invisible; the dogfood instance showed it on the
  first run after adoption.
- **Adoption obeys the rule an add obeys.** Req 20 is "behave exactly as if I
  would add the service manually", and adding a second API key by hand is
  refused with a 409 (req 12: keys never fail over). The first cut adopted past
  that and put two keys on a card the API allows one of. An add that would be
  refused is an adoption that is refused — and nothing is lost, because
  `collectServiceCredentialEnv` already delivers the stored credential, so the
  deployment's variable was shadowed and unused before adoption existed.
- **A remembered removal has to leave `process.env`, not just the route list.**
  `listConfiguredCredentials` and `stringSelectionFor` read the raw variable, so
  remembering the removal only in the store would have left the credential
  working and the user's removal a no-op. Unsetting the variable — once, in
  adoption, and again at the delete — is what makes every downstream reader see
  the absence without any of them learning what a removal is.

**What the independent review changed.** Six more, on top of the four above, and
the pattern is the same one: each is a rule stated correctly here and
implemented as a near-neighbour of itself. The first is the one that mattered.

- **"Is this a stored route" cannot be answered from the id's shape any more.**
  `isStoredCredentialRouteId` asked `startsWith("cred_")`, which was faithful
  while every stored row had a minted id — and req 20 breaks that on purpose,
  because an adopted row keeps a LEGACY reserved id so pinned sessions still
  resolve. Under the old test an adopted credential answered "not stored" and
  spawn shaping handed it the mode's **group** variable, which always carries
  the group's FIRST credential. Order or fail over onto the adopted row and the
  turn authenticated as one credential while being attributed to another —
  possibly the one ShipIt had just benched, which is the exact hazard phase 5
  introduced the per-route variable to remove. The question now goes to the
  store, as a **required** parameter on `serviceRoutingForSelection`: a default
  would let a call site that forgot it fail silently, which is the failure.
- **`isUnconnectedAttempt` is not sufficient to authorise a deletion.** Its own
  docstring names the hole — an unreadable identity *proceeds*, so a connected
  account can lack `externalId` — and reconnect supplies the other clause by
  moving it to `authenticating`. Only the dialog can answer the real question,
  which is whether it minted the id.
- **A detached login has no owner.** Running `cancel → start` from the click
  handler put it outside the dialog's `left` ref *and* outside its
  `startingSignIn`, which produced two defects at once: a login that could
  outlive the dialog, and a step 3 that opened on the flow's failure screen.
  Both go away by routing through `startSignIn`, from a mount effect — mount
  genuinely is the event here, since the Reconnect click is what mounts it.
- **`signInStalled` needed the reconnect's own beat.** The server's
  `authenticating` broadcast lands *after* `startSignIn` resolves, so between
  them the row is `ready`, nothing pending, nothing starting — the stalled
  predicate exactly. `reconnectLeftReady` gates it, and a thrown start sets that
  flag so the real failure still reaches its *Try again*.
- **Cancelling a login does not clear its challenge**, so a dead code could
  render as the live one and suppress the stalled state. The adopt path clears it.
- **Two-write windows have a correct order.** `save()` swallows failures, so
  adoption's (row, provenance) and deletion's (route, marker) pairs each fail
  one of two ways. Provenance before row self-heals; marker before delete leaves
  a removable row rather than re-importing what the user deleted.

**Measured, at the same 470px the compaction was specified against.** The
DeepSeek key card is **148px → 78px**; the Anthropic subscription card, which
was 272px holding one credential, is 154px holding *two* and a routing band. A
credential row is 34px, from 39px for a supplied key and ~120px for an account.

### Two bugs the compaction exposed (reqs 19-21 follow-up)

Both reported from the dogfood instance, and both are the same shape as the ten
before them: a rule stated correctly, implemented as a near-neighbour of itself.

**"Quota" was read as "account".** The failover cutoffs rendered on
`provider && accounts.length > 1`, and the quota pill only on account rows —
both on the belief, written into two comments, that *only account-backed
subscriptions report a quota*. They do not. A snapshot is recorded per **route**
and gated only on the mode being a subscription (`bootstrap-managers.ts` →
`credentialOwnerForRouteId`), so an Anthropic plan token supplied as a string
reports its 5h and 7d windows exactly as an account does — the header pill has
always rendered one for those routes. The install that reported it had two plan
tokens and no account, so it got an order, a strategy, and no numbers of any
kind. Three changes, one fact:

- `modeReportsQuota(serviceId, billingMode)` in the catalogue — a mode reports a
  quota when its declared `QuotaIntegrationId` is one this build implements.
  Every `sub` mode declares one (the type requires it), and `zai-plan-usage` has
  no reader yet, so **planning#339 is unchanged**: GLM still gets no cutoffs and
  no read-out, now for the right reason and from one line rather than two
  beliefs.
- The row shows `SubscriptionLimitPill` for a supplied subscription credential,
  as the header always has.
- `stringSelectionFor` grew the account walk's other two tiers — *looks spent*
  and *over cutoff*, from the same `isOverCutoff` / `snapshotExhaustedResetAt`
  helpers and the same snapshot map. Without this the cutoff control would have
  been a number that never fires, which is what the original comment was right
  to refuse. Only refusal memory still SKIPS; telemetry orders and never
  removes (docs/260-turn-level-account-routing req 9).

Req 19 is what made this a bug rather than a quirk: once both delivery shapes
are identical rows, a threshold honoured for one and silently not the other is
a carve-out no user could predict.

**One token, listed twice.** `adoptEnvCredentials` imported
`ANTHROPIC_AUTH_TOKEN` into a row of its own while the dogfood seeder had
already stored that exact secret through the ordinary API — so one credential
appeared as two, and was offered to itself as a failover target that can only
fail with it. Not dogfood-specific: any user who pastes the key their deployment
also sets gets the same pair. Adoption now compares by **value** — provenance is
exactly what is missing, since a seeded row is indistinguishable from a typed
one — and both declines to create the duplicate and **withdraws one it created**
before the rule existed. The withdrawal is deliberately narrow, because it
deletes a credential: only a row adoption created, whose secret is still the one
adoption imported, and whose label ShipIt still generated. Any of those failing
means the row is the user's, and a duplicate they can see beats one deleted
behind their back.

### One state, because the second one could not be named

**Background work, 2026-08-13.** The section reported which model it runs on *and* where that
choice came from — and there was no word for the second half that a reader could use. "On the
default", "auto-configured", "pinned" were all tried; the report on the third was *"I don't
understand on the default, auto-configured or pinned. Even I, the developer, so I imagine the
user would not understand what this means."*

The instinct is to keep renaming. The answer was to **delete the state**: ShipIt writes the
setting once, when the first service is configured, and only the user changes it afterwards.
With one state there is nothing to name, and three things fall out of the design rather than
being tidied up in it — the sentence explaining what the default follows, the line reporting
which state is in force, and the model menu's "ShipIt's default" row, which existed only so the
user could get back to the state that no longer exists.

**The seed is on the READ path** (`seedNonTurnModel` in `services/settings.ts`), for the reason
`resolveHarnessOnboarding` above it already argues: a mutation-site seed is a list that a
newly-added credential path quietly falls off, and there are four such paths today — a pasted
key, `upsertSingleStringCredential`, an account connecting, and boot-time env adoption. **Two**
read paths call it, and between them they cover every way a credential can arrive:
`getGlobalSettings`, which is every bootstrap, including an install that already had
credentials before this existed; and `buildAgentListPayload`, which every credential mutation
broadcasts through. The second was missing in the first cut and cross-backend review found what
that cost: add the first service from an already-open Settings tab and nothing wrote the
setting, so the section read "Nothing to run it on yet" over a runnable install — the
empty-while-a-service-exists state req 9 forbids. The window before the first read is still not
a gap: `resolveNonTurnModel` falls back to the first eligible model when nothing is stored, so
background work runs, and it runs on the same model the seed then writes.

**The setting rides `agent_list` too**, for the reason the reviewer slots do (docs/261): an open
Settings tab that does not follow a credential change shows the answer from before it. The same
review found the other half of that — remove the chosen model's credential and the section
still read "Runs on Claude Code" while background work was already failing, because the warning
is gated on the resolution being absent and the client had never been told it was. The pair
ships as `null` rather than an omitted key, because for this pair the server *does* clear, and
an omitted key cannot be told apart from an older server.

**Only when there is none**, never over a value. That single condition is what keeps this from
becoming re-pointing under another name, and it is the half that carries a cost: remove the
credential the chosen model used and the setting still names it, so background work fails and
says so, where an unset setting would have quietly moved to whatever survived. That is the
trade the requirement asks for — "the default becomes the changeable setting, so ShipIt does
not update it anymore" — and the warning that reports it is the one that already existed for a
stale pin.

**Three things it refuses to write, all from that review, and all the same mistake in different
clothes — making a permanent decision out of something that was never settled.**

- **An unfinished sign-in.** An account row exists from the moment a login starts, and
  eligibility counts it because routing does. A write that outlives it must not: req 17 deletes
  an abandoned attempt, and the setting would be left naming a service the user never
  connected, with nothing to re-point it. `listConfiguredCredentials` grew a
  `requireReadyAccounts` option for this one caller.
- **A harness only assumed installed.** `isHarnessInstalled` answers *true for everything* when
  a deployment ships no install report, so the catalogue walk can pick a model whose CLI is
  absent. Survivable while the answer is re-derived every read; frozen, it is a permanent
  failure. The `AgentRegistry` has probed `$PATH`, so the walk is given its answer instead —
  via `HarnessSearchOpts.isInstalled`, so it **keeps walking**. The first version of this guard
  rejected the walk's result instead of steering it, which left an install with no report and
  one harness present holding no setting at all: the empty state req 9 removes, reached by the
  code that exists to prevent it. A second review round caught that.
- **A write that did not reach the disk.** `save()` logs and swallows, so a full or read-only
  credentials directory would leave a value in memory that vanishes on restart — and, if
  services changed meanwhile, seeds a *different* model next boot with no user action.
  `CredentialStore.stampNonTurnModel` rolls a failed write back, the same bargain
  `stampHarnessOnboardingCompleted` strikes one field over. It holds the emptiness check too,
  so no caller can forget it — but **not** as a concurrency guard: this write-up claimed that
  and the claim was withdrawn, because Node runs one request at a time and neither sequence
  yields, so there was never a window for a concurrent PUT to slip into.

**And `null` over the wire re-proposes rather than clearing.** `PUT /api/settings` still accepts
`nonTurnModel: null`; nothing in the UI sends it, but a tab left open across a deploy can, and
leaving the setting empty would restore the state this removed. The clear is now followed
immediately by the same proposal a fresh install gets.

**Cancelling a sign-in is a change in what the install can run.** `cancelAccountAuth` resets a
row to *ready* when the account already holds credentials on disk, and that route announced it
as `provider_accounts` alone — a change to a row. Since the seed rides `agent_list`, and since
the seed deliberately ignores an account that is still `authenticating`, an install whose first
ready credential arrives by cancelling out of a second sign-in sat unseeded until the next page
load. The route now emits both. The `agent_list` producer census in `can-run-turns.test.ts`
moves 10 → 11, which is that guard working as designed.

**One residual, accepted rather than fixed.** The HTTP response to a model change and the
`agent_list` event are separate transports, so an event *computed* before that write but
*delivered* after it re-applies the older value in the browser. It needs a credential mutation
concurrent with the model change, and it corrects itself on the next event or reload; the
Reviewer tab has carried the identical exposure since docs/261. Closing it properly means
versioning the payload, which is more mechanism than the window earns — but it is a real
window, and it is recorded here rather than left for the next reviewer to re-find.

**Two rows, not three columns**, in the same change. The description sat in a column beside the
controls, wrapping at ~34 characters over seven lines; it is now above them, full width, and
one sentence. The line beneath it carries only what the two controls cannot state — the derived
harness — because they already name the service and the model. The description also stopped
enumerating: "such as naming a session or writing a pull-request description" says the examples
are examples, since the list of work ShipIt does outside a turn is not closed.

### The service list says which harness could run each service (req 22)

**2026-08-13.** Step 1 of *Add a service* listed six services and the billing modes each takes,
and said nothing about the pairing that decides whether the credential will be usable at all.
GLM and OpenRouter serve Anthropic Messages and reach only Claude Code; OpenAI serves Responses
and reaches only Codex. (The OpenRouter half stopped being true on **2026-08-15**, when its
Responses surface was verified and its DeepSeek rows gained the style — planning#391. Left as
written because it is what made the case for this change; the cell was always derived, so it
answered differently the moment the row did.) On an install with one harness, a third of the
list was a dead end the
user could only discover **after** buying a key and pasting it — a ShipIt-imposed failure of
exactly the kind req 1 exists to prevent.

**The answers sit BESIDE the list, and the rows are untouched.** Step 1 is now two columns: the
service list exactly as it was, and a table of one column per **installed** harness whose rows
line up with it, plus a caption saying what a tick means.

That distinction is the whole of the human's correction, and the first cut got it wrong — it put
the tick and the dash *inside* each service button, which grew a control the user presses into a
place to read facts from and widened every row to do it: *"I meant leaving the panels with the
services as is, with the separate table on the right."* Two prototypes settled the rest (bare
columns versus an enclosing panel); the enclosure was dropped because it added chrome to a quiet
dialog and an alignment constraint between two containers, which it then failed on the first
attempt by pushing every cell half a row down.

Three consequences worth stating, because each is a thing that could be "tidied" back into a bug:

- **The list keeps its old width** — `basis-[26rem]`, which is `max-w-md` less the dialog's
  padding — so the rows are byte-for-byte the rows that were there before (measured: 414.0px
  before, 414.0px after). The dialog is wider by exactly the table: `40.25rem` is 26 of list, the
  `gap-4`, two `5.5rem` columns with a `gap-1`, and `p-4` twice.
- **Only step 1 is wide.** Steps 2 and 3 return to `max-w-md`. The dialog visibly changes width
  once, when a service is picked; the alternative strands a mode choice and a sign-in code in a
  box half as wide again as their content.
- **The alignment is a shared row height, never a measurement.** Each cell carries the row
  button's own metrics — a transparent border, `py-2`, `text-xs` — so neither side is told the
  other's height, and both columns walk `allServices()` in one order, so row N here is service N
  there.

**The cell is the picker's own eligibility rule, asked about a credential that does not exist
yet.** `harnessSupportsMode` (`catalogue/index.ts`) calls `eligibleEntriesForHarness` with a
*hypothetical* credential of each shape the mode accepts, rather than testing the style join and
the credential shape independently — the two must be satisfied by the same credential, which is
the bug `harnessCanCarry`'s docstring records, and a second statement of the rule is a second
thing to get wrong. A test asserts the two answers agree for every `(service, mode, harness)` in
the catalogue.

**State the guarantee exactly, because it is existential.** The cell is true when **some** mode
and **some** accepted credential shape would work, while the user goes on to choose one mode and
supply one shape. A service whose answer differed between them would be ticked here and offer
nothing there. Cross-backend review raised that as the central risk, and the answer is a guard
rather than a per-mode table: no shipped service differs by mode or by shape, and
`catalogue.test.ts` fails the build on the day one does — which is the day the cell has to become
per-mode. Building that now would be mechanism for a row that does not exist.

**Two holes the cell inherits from eligibility, both now guarded at their source.** Neither is
reachable today and neither is this feature's to fix — the picker has them identically — but
review found them and a silent inheritance is how they stay found only once:

- **Endpoint capability is not part of eligibility.** A harness declaring
  `spawn.endpoint: { kind: "none" }` can reach only its own vendor, and nothing in
  `eligibleEntriesForHarness` says so. A test asserts such a harness joins only its
  `nativeService`; it is vacuous today, deliberately, and fires when the first one is added.
- **`targetOverride` can outrun `harnessCanCarry`.** A harness with no default string
  destination is refused a string credential outright, even where the *service* declares a
  per-harness override that spawn shaping would honour — so it would read as unsupported and be
  perfectly spawnable. A test asserts no override names a harness lacking a default. GLM's
  override is the live case, and its harness has one.

Two deliberate narrowings. The columns are the harnesses the install **has** (the same
`installed` filter `InstalledHarnesses` applies), so an empty agent list — the bootstrap has not
landed — draws no table rather than a table of dashes. And the tick is **not** a gate: every row
stays selectable, because a harness can arrive with a later image and refusing the choice would
make ShipIt the obstacle.

The empty-list case carries a residual review named and this design accepts: a user who opens the
dialog *and* picks a service inside the window before the agent list lands never sees the table
for that choice. Closing it means a loading state and disabled rows — mechanism for a window
that requires clicking through Settings faster than the bootstrap that rendered it — and the
alternative reading, drawing all catalogue harnesses as columns, would claim harnesses the
install may not have. Both are worse than the gap.

**The answer is said in words, not only drawn.** Each cell carries `sr-only` text rather than an
`aria-label` on its span — review found the latter unreliable on a generic role — and the text
names **both** sides: "Codex cannot run GLM (Z.ai)", never "cannot run". That is load-bearing now
that the cells live in their own column, away from the service names: a bare "runs" would answer
a question the listener cannot see. A test asserts the words rather than only the
`data-supported` attribute, which would have kept passing if both the glyph and the spoken answer
disappeared.

## Key files

| File | Why it matters |
|---|---|
| `shared/agent-registry.ts` | `AGENT_DEFS`, `CLAUDE_MODELS`, `ALLOWED_ENV_KEYS`, `isAllowedAgentEnvKey` |
| `shared/types/agent-types.ts` | `AgentId` — the conflation lives here |
| `session/agents/claude/process.ts` | Both spawn sites, the scrub, `AUTH_ERROR_PATTERNS` |
| `orchestrator/provider-account-manager.ts` | `reservedRouteFor`, `hasAnyAuthForProvider` — route eligibility |
| `orchestrator/session-agent-env.ts` | `selectAgentEnvForPush` — credential delivery to a container; settles a selection-less session onto the derived default before the turn's readers run (planning#353) |
| `orchestrator/local-agent-home.ts` | `resolveLocalAgentHome` — why reserved routes are unscoped |
| `shared/model-windows.ts` | First-frame context window |
| `client/components/ModelPicker.tsx` | The split picker: `HarnessSelector` + `ModelSelector`, model rows grouped by `(service, billing mode)`. Replaced `ModelAgentSelector`, whose hand-kept `METERED_MODELS` set went with it. `boundSession` / `displayedHarness` decide whether it describes a session or previews the next one |
| `client/utils/new-session-agent.ts` | `newSessionAgentId` — the one rule for the harness a brand-new session is created on, read by the connect URL and by the picker that displays it |
| `shared/types/usage-limits-types.ts` | `SubscriptionLimits` — already keyed by `routeId` |
| `orchestrator/agents/*/limits-provider.ts` | The two first-party readers, built per-`AgentId` because each belongs to its CLI's own vendor; each declares the `(service, mode)` it reports for (req 10) |
| `orchestrator/limits/zai-limits-provider.ts` | GLM's plan quota (planning#339) — the first reader that is not a harness's, pulled over HTTP rather than event-fed, with a deliberately fail-closed parser for an undocumented endpoint |
| `orchestrator/usage.ts` | `RecordedTurn` — token/cost accounting, distinct from quota |
| `orchestrator/service-routing.ts` | The resolver: configured credentials, per-mode turn routing (including which of a subscription's string credentials), the spawn identity, and `firstEligibleSelectionForHarness` — the default for a session that never picked a model (planning#353). Phase 7's second caller |
| `orchestrator/credential-failure-policy.ts` | req 12's branch — `sub` fails over, `key` stops — asked by every gate so it cannot be drawn twice |
| `orchestrator/turn-attribution.ts` | The `cost_usd` rule, shared by both usage writers |
| `shared/spawn-routing.ts` | The two shaping rules — `applyServiceRouting`, `codexProviderArgs` — on the shared side of the container boundary, so the orchestrator's own CLI shell-out uses the same source a turn does |
| `session/agents/codex/spawn-shaping.ts` | Codex's `model_providers` block — the only way to redirect that CLI. Re-exports `shared/spawn-routing.ts` |
| `orchestrator/non-turn-model.ts` | Req 9's resolver: the pinned or derived selection, the derived harness, its route and shaping |
| `orchestrator/services/non-turn-work.ts` | Runs it: the brokered generation, the usage row, and the durable failure notice |
| `client/components/Settings/ServicesPanel.tsx` | The card list and `AddServiceDialog` — the one way in (req 17), sign-in included |
| `client/components/Settings/ProviderAccountRows.tsx` | The rows, plus what the dialog shares with them: `AccountChallenge`, `createAccountAndStartLogin`, `abandonAccount`, `signInBlockedReason` |
| `orchestrator/session-namer.ts` | Naming's CLI shell-out, now pointed at the resolved selection and reporting its telemetry (req 9) |
| `client/components/Settings/ServiceCard.tsx` | The **one** card the Services list is built from: chrome only — avatar, service name, billing-mode and count pills, the `N models` control, and the routing band when there is something to route between. **No card action** (req 17) and no credential logic |
| `client/components/ServiceLogo.tsx` | The vendor marks every surface that names a service draws: the card avatar, the add-flow's service list, the model menu's group headers, and the service picker's rows and trigger. Monochrome `currentColor` paths (Simple Icons, CC0), keyed on `ServiceId`, taking a `{ id, name }` (`ServiceIdentity`) rather than a `ServiceDef` because a wire model row carries only those two, with the service's initial as the fallback for a catalogue row that has outrun its artwork |
| `client/components/Settings/ServicesPanel.tsx` | The list and the add-flow. Decides which bodies go in a card, what the routing band holds, and what a credential of that mode is called |
| `client/components/Settings/ProviderAccountRows.tsx` | Was `ProviderAccountsCard`. The account rows, the login challenge and their notices — a body, not a card. `AddAccountButton` is its header half |
| `client/components/Settings/CredentialRouting.tsx` | `CredentialSelectionModeControl` + `FailoverCutoffControls`, keyed by `(service, billing mode)`. Replaced the two copies of the selection mode that wrote the same key |
| `client/components/Settings/BackgroundWorkSection.tsx` | The visible setting (req 9): one state, seeded by `seedNonTurnModel`, with the derived harness shown as a fact |
| `client/components/NonTurnFailureCard.tsx` | The dismissible notice; dismissal is state on the persisted row, never its removal |

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
