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
| **Service** | a credential + endpoint, speaking one or more API styles | its API key or subscription |
| **Model** | a model id a service offers | the pair (service, model id) |

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
Codex and let the turn fail, which is precisely the listed-but-broken failure mode
req 12 exists to prevent elsewhere.

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

2. `ALLOWED_ENV_KEYS` is a **compile-time constant** (`agent-registry.ts:303`). One key
   name per service means one code change and one release per service, which directly
   contradicts req 10. The feature needs a *runtime* service-credential mechanism; the
   allowlist is a dead end for it, and this doc previously proposed exactly that dead
   end.

Neither correction changes the requirements — they change what the design has to
build, from "add a string" to "add a delivery path".

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
OpenAI Responses API with a Codex adaptation. So one DeepSeek key should surface its
models under both harnesses (req 8), while an OpenAI-style-only service surfaces under
Codex alone. This concrete asymmetry is the evidence for modelling API style per
service rather than treating it as a global scope decision.

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

Settled by the 2026-08-05 answers. Nothing here is deferred.

**Data model.** A user-owned list of **services** (req 10), each carrying a display
name, a credential (key *or* subscription), a base URL, and the API styles it speaks —
with, per style, the models it declares as working there (req 8). Anthropic and OpenAI
are rows in that list, not special cases (req 7). `AgentId` keeps meaning *harness*
only, and gains a declared API style.

The picker's list for the active harness is then every `(service, model)` pair the
service declares under that harness's style, filtered to services with a usable
credential (reqs 9, 11). Note the entry is the **pair**, not the model id — the same id
can come from more than one service at different prices.

**Full separation is the point.** No code path should ask "which vendor's agent is
this?" to decide anything about credentials. Concretely, req 2 means a user with only a
DeepSeek key runs the Claude Code harness with no Anthropic account anywhere in the
system — so `providerAccountManager`'s per-`AgentId` account model has to become a
per-*service* one, not gain a fallback branch.

**Credential failure is not ShipIt's to recover** (req 15). The design deliberately has
no service re-prompt flow; an earlier draft proposed one. See the findings note above
for what has to be *removed* to satisfy this.

**Eligibility** (req 11) moves from `hasAnyAuthForProvider(provider)` to a per-model
question: *is there a configured service offering this model for this harness?* With
Anthropic as an ordinary service, "Claude with no account connected" and "DeepSeek with
no key" become the same condition answered by the same code. This retires the spike's
overstatement rather than patching it.

**Mid-session model switching** (req 5) is a capability question per harness, not a new
mechanism: the model is already a per-turn spawn argument, and `AgentCapabilities`
already carries per-harness flags. A switch that crosses *services* additionally
re-resolves the credential and base URL for the next spawn.

This was flagged as an open implementation unknown; review settled it from the code.
ShipIt already forces the boundary: `releaseResidentOnModelChange`
(`resident-model-guard.ts`) kills a resident process whose spawn-time model no longer
matches the selection, and the turn respawns with the new `--model` and
`--resume <session>` (`agent-execution.ts:291`). A model change is rare and
user-initiated, so one respawn was judged cheaper than mid-stream model switching.
A service change rides the same boundary — so req 5 needs no new lifecycle mechanism,
only the credential and base URL re-resolved on that respawn.

Note the correction this implies for "the model is already a per-turn spawn argument":
for a **resident** process it is not. Later turns are injected without spawning until
that guard forces a boundary, which is precisely why the guard exists.

**Credential delivery** cannot reuse the existing pipe as-is — see the two corrections
under Findings. It needs a runtime, per-service credential mechanism (the allowlist is
compile-time, which contradicts req 10) that also reaches compose-backed containerized
sessions (which today receive only compose-declared and `mcp__*` secrets).

**Subscription-backed services are a second, unbuilt path.** Req 7 makes a subscription
a first-class way to identify a service, but subscription credentials travel through
account credential roots and filesystem mounts, not `agentEnv` — so "add a service"
covers two quite different flows: store a key, or run a login. Only the first is
designed here; the second is on the checklist and is not yet specified.

**Spawn shaping** sets the base URL and credential at both spawn sites, after the
scrub, from the *selected model's* service rather than from a model-id prefix.

**Non-turn work** (req 12) — session naming and PR descriptions run on a service the
user configures **explicitly for that purpose**, resolved independently of whatever the
session is using. Deliberately not "follow the session's model": the failure this
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
- The **401 misfire** is fixed by *deleting* behavior, not adding it (req 15). When a
  service's credential fails, ShipIt stops and reports it — recovering from a bad
  credential belongs to the harness. So the work is to stop intercepting: today
  `AUTH_ERROR_PATTERNS` (`process.ts:43`) catches auth-shaped text and drives ShipIt's
  own re-auth flow, which for a non-vendor service is both wrong and unfixable. That
  interception must not apply to a service credential.

  The carve-out is deliberate and narrow: ShipIt keeps managing **multiple
  subscriptions** and routing turns between them, because harnesses do not do that.
  Quota failover and the existing account-level auth recovery (docs/142, docs/150)
  stay exactly as they are. The distinction to encode is *"which subscription should
  this turn use"* (ShipIt's job) versus *"this credential is bad"* (the harness's).

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
