---
issue: https://linear.app/shipit-ai/issue/SHI-319
title: Custom models
description: Separate harness from service so a user can run any configured service's models on any compatible harness.
---

# 252 — Custom models

Implements [`requirements.md`](./requirements.md), which has no open questions.

## The idea

ShipIt integrates **harnesses**, not models. `AgentProcess` spawns a CLI and
normalizes its event stream; the model is a `--model` argument that CLI forwards to
an API. So running a different vendor's model does not need a new backend — it needs
the same CLI pointed at a different endpoint (reqs 1, 3).

That is the whole mechanism, and it is why this is cheap. Everything expensive in an
agent integration — the tool map, the event parsing, skills disclosure, MCP config,
steering, permission modes, plan mode — belongs to the harness and is untouched
(req 6).

Untouched is not the same as guaranteed. Req 6 is **best-effort**: ShipIt adds no
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
no way to say that today, and every awkwardness below is a symptom of that single
gap. Resolving it is the real work; DeepSeek is just the first case that forces it.

**The split the requirements settle on is three-way, not two-way** (reqs 7–9):

| Concept | Is | Identified by |
|---|---|---|
| **Harness** | a CLI to spawn, speaking exactly one API style | `claude`, `codex` |
| **Service** | a catalogue entry: endpoints, API styles, and the models declared for each | a `serviceId` such as `openrouter` |
| **Model** | a model id a service offers | the pair (serviceId, model id) |

A service is *not* the credential. One service holds zero or more user-supplied
credential routes — see the ownership table under Design, which req 15's "another
subscription of the same service" depends on.

A model id alone is **not** a global identifier: the same model is reachable through
DeepSeek directly and through a gateway like OpenRouter, at different prices and
possibly different API styles. Whatever the picker persists must therefore carry the
service identity, or "the selected model's service" cannot be resolved and req 14
cannot say which service billed a turn. This is a change from the spike, which keyed
everything off a bare model id.

Compatibility is **partly derived, partly declared** (reqs 8–9). Speaking a style is
necessary but not sufficient: a service also declares *which of its models* work under
each style it speaks. A model is offered on a harness when the service speaks that
harness's style and lists that model for it.

The declaration is not bureaucracy — it is the only honest way to express reality.
DeepSeek speaks both styles yet supports only `deepseek-v4-flash` under Codex, and
Codex additionally wants per-model metadata (context window, tool format, reasoning
settings) beyond a bare id. A purely derived rule would list `deepseek-v4-pro` under
Codex and let the turn fail. Nothing forbids that at runtime — req 11 is only about
credentials — so the catalogue is where it has to be prevented, by not listing the pair
in the first place (req 8).

What still falls out cheaply is req 9: a new harness picks up every configured service
that speaks its style, limited to the models already declared for it. Nothing has to
enumerate harness×service pairs by hand.

This is also why "should we support OpenAI-compatible providers?" was the wrong
question. It is not a scope boundary; it is a property of each service, and it decides
which harnesses that service appears under rather than whether it is supported at all.

## Findings from the spike

All verified against the code on this branch, not inferred.

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

   This *used* to contradict req 10, when req 10 promised that trying a new service
   needed no release. It no longer does: the catalogue ships with ShipIt, so a new
   service is already a ShipIt change, and adding its key name in the same change costs
   nothing extra. **The requirement that justified building a runtime credential
   mechanism has disappeared, so the mechanism should not survive it** — a compile-time
   key name per catalogue service is now the simpler and sufficient answer.

The compose gap in (1) is unaffected and still has to be closed, on its own merits
rather than as a consequence of req 10.

### The credential-scrub only applies to local mode

`scrubEnvAuthForScopedHome` (`process.ts:28`) deletes `ANTHROPIC_API_KEY` and
`ANTHROPIC_AUTH_TOKEN`, but only when a **scoped home** is set. `session-worker.ts:742`
constructs `new ClaudeProcess()` with no resolver, so containerized sessions are never
scrubbed; only the local-mode factory (`app-di.ts:574`) passes one. And
`resolveLocalAgentHome` (`local-agent-home.ts:82`) returns `undefined` for the reserved
env routes anyway.

Consequence: a custom credential must **not** reuse an Anthropic variable name, or the
route works or fails depending on how the install happens to be signed in — a
difference unrelated to the feature. A distinct name (`DEEPSEEK_API_KEY`) sidesteps it
entirely, and behaves identically in a container, in local mode, and under dogfood.

### There are two spawn sites, not one

`ClaudeProcess.run` (PTY) and `StreamingClaudeProcess.run` both build a spawn env.
**Streaming is the default whenever live steering is on**, so anything wired into only
the PTY path unit-tests green and does nothing in a real session. Confirmed in the
dogfood run: the log line was `[streaming-claude] spawning:`.

Any env-shaping for custom models must be applied at both, and **after** the scrub —
ordering is load-bearing, and is pinned by a test.

### API style is a property of the service, and services differ

DeepSeek V4 Flash is served by DeepSeek, DeepInfra, Parasail, Fireworks and
SiliconFlow, aggregated by OpenRouter, plus open weights for self-hosting. API style
varies per service and is not inferable from the model: DeepSeek exposes an
Anthropic-style surface (`/anthropic`), OpenRouter exposes an Anthropic Messages
endpoint *and* OpenAI-style ones, while several others are OpenAI-style only. Pointing
a harness at a service that does not speak its style fails at the **wire format**, not
at auth — a failure that looks nothing like a bad key.

(An earlier draft claimed only DeepSeek served an Anthropic-style surface. That was
wrong, and the correction strengthens the case for storing style per service rather
than hardcoding one endpoint.)

DeepSeek itself speaks **both** — the `/anthropic` endpoint and, per its own docs, the
OpenAI Responses API with a Codex adaptation. So one DeepSeek key surfaces models under
both harnesses — but *not necessarily the same models*: only `deepseek-v4-flash` is
supported under Codex today, which is precisely why req 8 makes the per-model
declaration part of the service rather than deriving it from the style set. An
OpenAI-style-only service surfaces under Codex alone.

### Two things break — and a third that only looked broken

1. **A 401 triggers the wrong recovery.** `AUTH_ERROR_PATTERNS` (`process.ts:43`)
   matches `"unauthorized"` / `"authentication_error"`, so a bad custom key kicks the
   session into the *harness vendor's* OAuth re-auth flow, which cannot fix it.
2. **Non-turn CLI spawns fail — but the two are not the same path.** Corrected on
   review: session naming *does* have a credential seam, selecting the route a turn
   would use and passing that account's credential root
   (`graduate-session.ts:250`, `session-namer.ts:28`); it is implicit and agent-bound,
   not absent. What it lacks is an *explicit, service-configured* choice (req 12). PR
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
with no quota *should* show nothing (req 13). Kept in this list because the mistake is
easy to repeat — the correct behavior is indistinguishable from the bug by inspection.

### Prompt caching is not portable

`PRECOMPUTED_INSTRUCTIONS` renders every prompt variant once at module load
specifically to keep the CLI string byte-stable for Anthropic's prompt cache. Another
service has its own cache semantics, so cost and latency on its models are not
comparable to the tuned path, in either direction.

## Relationship to the spike

An **experimental spike** was written before this document, to answer "does this work at
all", and **removed from this branch on 2026-08-05** once it had. It was never an
implementation of these requirements: it hardcoded a single model id in `CLAUDE_MODELS`,
hardcoded DeepSeek's endpoint, and made `hasAnyAuthForProvider`/`reservedRouteFor` treat
a DeepSeek key as a Claude-provider route — an overstatement it accepted deliberately,
and which req 11 now rules out. It was deleted rather than kept because shipping a
design alongside an implementation that contradicts it is worse than shipping neither.
The code is recoverable from this branch's history if anyone wants to re-run the
experiment.

**It did establish that the approach works.** A full session ran on DeepSeek V4 Flash
through the unmodified Claude Code harness: multi-step tool use, correct output, a
second dispatched turn, with `providerRouteId: claude-api-key` and no backend
credential present. That is the evidence req 1 is achievable; everything else about the
spike is scaffolding.

## Design

Settled by the 2026-08-05 answers. **User-added services are key-authenticated**
(req 7): a subscription needs its own login, refresh and account handling, which cannot
come from configuration, so adding subscription-backed services is out of scope here.
Subscriptions remain first-class for the vendors ShipIt already implements.

**Data model — two layers, with different owners.**

*ShipIt ships the catalogue* (req 8): which services exist, which API styles each
speaks, and per style, which of its models work there plus any metadata that style needs
(Codex wants context window, tool format and reasoning settings). This must be
a **maintained subset**, not a mirror of everything a service offers (req 8). Only a
handful of models are worth using for coding at any time, so an aggregator advertising
400+ models contributes a short curated list rather than 400 rows.

That choice dissolves a tension rather than managing it. Per-model metadata — Codex's
context window, tool format and reasoning settings — is only awkward when there are
hundreds of models to state it for. With a curated subset it is simply stated per model,
and no generation, family-rule scheme, or defaults-plus-exceptions machinery is needed.
The cost is a judgement call ShipIt owns and revises: which models are worth carrying. A per-style endpoint belongs here too:
one base URL per service is wrong for a service whose styles live at different paths.

*The user supplies credentials* (req 10) for the services they want to use. That is the
whole of what they own; they are not authoring catalogue entries. The consequence is
explicit in req 10 — a service ShipIt does not know about needs a ShipIt change.

**Four distinct identities, which an earlier draft blurred into one.** This doc first
called a service "a credential + endpoint" and later a ShipIt-owned catalogue row; those
are different things, and req 15's "another subscription of the same service" only makes
sense once they are separated:

| Thing | Owner | Example |
|---|---|---|
| `serviceId` | ShipIt catalogue | `openrouter` |
| credential route | the user — one key, or one subscription account, belonging to that service | a stored key, or `acct_…` |
| selected model | the session | `(serviceId, modelId)` |
| turn route | resolved per turn from the credential routes of that service | which key/account this turn used |

One catalogue service can therefore hold several credential routes, which is exactly the
case req 15 fails over between.

Anthropic and OpenAI are catalogue rows like any other, not special cases (req 7).
`AgentId` keeps meaning *harness* only, and gains a declared API style.

The picker's list for the active harness is then every `(service, model)` pair the
service declares under that harness's style, filtered to services with a usable
credential (reqs 9, 11). Note the entry is the **pair**, not the model id — the same id
can come from more than one service at different prices.

**Full separation is the point.** No code path should ask "which vendor's agent is
this?" to decide anything about credentials. Concretely, req 2 means a user with only a
DeepSeek key runs the Claude Code harness with no Anthropic account anywhere in the
system — so `providerAccountManager`'s per-`AgentId` account model has to become a
per-*service* one, not gain a fallback branch.

**Credential failure branches on credential type, not on the error** (req 15). This is
the load-bearing simplification: ShipIt does not classify the failure, it looks at how
the failing service is authenticated — a fact it holds statically in the service row.
A subscription fails over to another subscription *of the same service*; an API key
does not fail over at all, and the turn stops.

Review confirmed this is the right axis and that the existing code already half-draws
it — but found the gate is applied in **one** of the two places that need it. Account
benching checks the route kind and bails for a reserved route
(`bootstrap-managers.ts:442`), while the same-turn quota retry does not: it fires on
`detectHardExhaustion(event.error)` alone (`turn-executor.ts:938`). A key-authenticated
service answering "quota exceeded" would therefore be retried once on the same bad key,
which is exactly what req 15 forbids. Both paths need the credential-kind gate.

That also means there is no service re-prompt flow to build; an earlier draft proposed
one. See the findings note above for what has to be *removed* instead.

The rule generalizes rather than invents. Today `provider-account-manager.ts` already
refuses to mark a reserved API-key route exhausted ("they are metered billing, not a
subscription window", `:642`), treats reserved routes as always usable (`:720`), skips
them when stamping exhaustion (`:800`), and never routes onto pay-as-you-go because a
subscription is unavailable (docs/150 req 12, `:605`). The work is to lift that from
per-`AgentId` accounts to per-service credentials, not to invent a policy.

**Eligibility** (req 11) moves from `hasAnyAuthForProvider(provider)` to a per-model
question: *does the service offering this model have a credential?* With Anthropic as an
ordinary service, "Claude with no account connected" and "DeepSeek with no key" become
the same condition answered by the same code. This retires the spike's overstatement
rather than patching it.

Note the narrow scope: eligibility is a **credential** check and nothing more. It does
not assert the model will work — that is req 6's best-effort territory — so there is no
runtime validation to build and no staleness policy to maintain. A model that stops
working at its service is a catalogue update in the next ShipIt release.

**Mid-session model switching** (req 5) is a capability question per harness, not a new
mechanism: the model is already a per-turn spawn argument, and `AgentCapabilities`
already carries per-harness flags. A switch that crosses *services* additionally
re-resolves the credential and base URL for the next spawn.

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
service and contradicting req 14.

So req 5 does need a change after all: the resident process's identity must be the
whole spawn-relevant tuple — harness, service, API style, endpoint, credential route,
model — not a model string. This is the same `(service, model id)` identity the picker
needs, applied one layer down; the two should share a representation rather than each
inventing one.

Note the correction this implies for "the model is already a per-turn spawn argument":
for a **resident** process it is not. Later turns are injected without spawning until
that guard forces a boundary, which is precisely why the guard exists.

**Credential delivery** reuses the existing pipe with **one** correction, not two. A
compile-time key name per catalogue service is sufficient: req 10's narrowing means a
new service already implies a ShipIt change, so naming its key in that same change costs
nothing, and no runtime dynamic-key mechanism is warranted. What does still need
building is the compose path — a compose-backed containerized session receives only
compose-declared and `mcp__*` secrets, so a stored service key never reaches it.

**Subscription credentials are out of scope for user-added services** (req 7), which
is what keeps credential delivery to one flow. Subscriptions travel through account
credential roots and filesystem mounts rather than `agentEnv`, and each needs its own
login and refresh — the reason req 7 draws the line where it does. Existing
subscription-backed vendors keep their current path unchanged.

**Spawn shaping** sets the base URL and credential at both spawn sites, after the
scrub, from the *selected model's* service rather than from a model-id prefix.

**Non-turn work** (req 12) — session naming and PR descriptions run on a service the
user configures **explicitly for that purpose**, resolved independently of whatever the
session is using.

The two halves are not symmetric, and an earlier draft wrongly said both merely preserve
today's behavior:

- *Session naming already behaves as required.* `generateSessionName` returns `null` on
  any failure and is documented as silent best-effort (`session-namer.ts:19`);
  graduation installs a placeholder first (`graduate-session.ts:158`) and keeps it when
  naming returns `null` (`graduate-session.ts:311`). Only the notice is new.
- *PR descriptions do not.* `generatePrDescriptionFromContext` returns whatever
  `generateText` returns (`services/github.ts:1412`), and in containerized production
  that is the empty string (`app-di.ts:485`) — the generic prose lives only in the
  `catch`, so it is reached on a thrown error and not on a blank result. Satisfying
  req 12 therefore means **normalizing a blank generation into the generic fallback**,
  with separate tests for the rejection path and the blank-success path.

**The notice has to be durable, not a toast.** Session naming is fire-and-forget: it can
finish while the user is looking at another session or with no viewer attached at all, so
a transient toast would be silent in exactly the case req 12 exists to prevent. It should
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

**Usage** (req 13) is reported per service. The existing types are partway there but
less far than this doc first claimed: the wire shape is **`AgentId` → `routeId` →
limits** (`usage-limits-types.ts:74`), so it is keyed by provider *and* route, and
`LimitsProvider`/`LimitsRegistry` are selected by `AgentId` first
(`agents/types.ts:22`, `limits-registry.ts:39`). An individual snapshot carries a
`routeId` and its comment does say "quota belongs to the subscription, not the
provider" — but that is the inner key only. Moving to services touches the map shape
and the registry, not just `LimitsProvider`.

Note this is two distinct things, and only the first is at issue: **quota telemetry**
(`SubscriptionLimits` — plan tier, rolling and weekly windows, `usedPct`, `resetAt`,
fed by `rate_limit_event` or `/api/oauth/usage`) versus **token and cost accounting**
(`RecordedTurn` — `costUsd`, input/output tokens, cache reads, context occupancy),
which ShipIt already records per turn for every provider. A key-based service has no
quota to report but full token accounting. Req 13 keeps that slot **empty** for such a
service, which is what a key-based route already does today — so this is inherited
behavior to preserve, not new behavior to build. Putting spend in that slot is
deliberately out of scope; the data exists, but it is its own feature.

**The known-wrong behaviors** resolve unevenly:

- The **empty usage pill** is not a bug at all once the indicator is per-service — a
  service with no quota should show nothing (req 13).
- The **non-turn failures** are covered by req 12, though as two separate paths rather
  than one.
- The **401 misfire** is fixed by *deleting* behavior, not adding it (req 15). Today
  `AUTH_ERROR_PATTERNS` (`process.ts:43`) catches auth-shaped text and drives ShipIt's
  own re-auth flow, which for an API-keyed service is both wrong and unfixable. That
  interception must not apply to a key-authenticated service; the turn stops and says
  so.

  Note what this does *not* require: ShipIt never has to decide whether a given error
  means "quota spent" or "key is bad". The branch is on the credential type, which is
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
| `client/components/ModelAgentSelector.tsx` | Picker, `METERED_MODELS` |
| `shared/types/usage-limits-types.ts` | `SubscriptionLimits` — already keyed by `routeId` |
| `orchestrator/agents/*/limits-provider.ts` | Per-`AgentId` today; becomes per service (req 13) |
| `orchestrator/usage.ts` | `RecordedTurn` — token/cost accounting, distinct from quota |
| `orchestrator/session-namer.ts` | Non-turn spawn with no service seam (req 12) |

## Verifying a service in dogfood

Not a requirement — a working note, kept because it is how this branch was validated
and it is not obvious. Declare the credential in the `dev` service's
`x-shipit-secrets`, set it in the **outer** Settings → Secrets, `shipit service restart dev`
(a running service does not pick up a newly declared secret), then drive the inner
instance over its API — `POST /api/sessions/headless` with `model`, then
`/agent/dispatch`, `/status`, `/history`.

**What this does not prove:** local mode spawns agents in-process and never exercises
the container path (`session-worker.ts:742`). A green dogfood run shows the model and
the stream parsing work; it does not validate a containerized session.
