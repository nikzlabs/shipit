---
issue: https://linear.app/shipit-ai/issue/SHI-319
title: Custom models
description: Separate harness from service so a user can run any configured service's models on any compatible harness.
---

# 252 — Custom models

Implements [`requirements.md`](./requirements.md), which has no open questions
remaining — the design below is settled and implementation is unblocked.

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
| **Model** | a model id a service offers | `deepseek-v4-flash` |

Compatibility is then **derived, not declared**: a service's models are offered on
every harness whose API style that service speaks. Nothing has to enumerate
harness×service pairs, which is what makes req 9 fall out for free — a harness added
later immediately picks up every already-configured service that speaks its style.

This is also why "should we support OpenAI-compatible providers?" was the wrong
question. It is not a scope boundary; it is a property of each service, and it decides
which harnesses that service appears under rather than whether it is supported at all.

## Findings from the spike

All verified against the code on this branch, not inferred.

### The credential pipe already exists, end to end

`CredentialStore.agentEnv` → `selectAgentEnvForPush` (`session-agent-env.ts:217`) →
`PUT /secrets` on the worker → worker `process.env` → `spawnEnv = {...process.env}`.
Gated by one predicate, `isAllowedAgentEnvKey` (`agent-registry.ts:314`). Adding a key
name to `ALLOWED_ENV_KEYS` covers **both** delivery paths — containerized sessions via
the push above, local mode via `app-di.ts:421`'s startup load into `process.env`
(req 10).

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
SiliconFlow, aggregated by OpenRouter, plus open weights for self-hosting. Only
DeepSeek's own surface is Anthropic-style (`/anthropic`); the others are OpenAI-style,
so pointing the Claude Code CLI at them fails at the **wire format**, not at auth —
a failure that looks nothing like a bad key.

DeepSeek itself speaks **both** — the `/anthropic` endpoint and, per its own docs, the
OpenAI Responses API with a Codex adaptation. So one DeepSeek key should surface its
models under both harnesses (req 8), while an OpenAI-style-only service surfaces under
Codex alone. This concrete asymmetry is the evidence for modelling API style per
service rather than treating it as a global scope decision.

### Three things break, all from the same root

1. **The usage pill is empty.** `ClaudeLimitsProvider` is event-fed from
   `agent_rate_limits`, which a non-Anthropic service does not emit.
2. **A 401 triggers the wrong recovery.** `AUTH_ERROR_PATTERNS` (`process.ts:43`)
   matches `"unauthorized"` / `"authentication_error"`, so a bad custom key kicks the
   session into the *backend vendor's* OAuth re-auth flow, which cannot fix it.
3. **Non-turn CLI spawns fail.** Session naming and PR-description generation spawn
   the CLI outside the turn path, so they get no custom routing and no backend
   credential. Observed as `[session-namer] claude CLI failed`; sessions fall back to a
   truncated-prompt title.

Each is code that assumes a service identity the type system cannot express — the
same gap as above, surfacing three times. None should be patched individually.

### Prompt caching is not portable

`PRECOMPUTED_INSTRUCTIONS` renders every prompt variant once at module load
specifically to keep the CLI string byte-stable for Anthropic's prompt cache. A custom
provider has its own cache semantics, so cost and latency on a custom model are not
comparable to the tuned path, in either direction.

## Relationship to the spike

PR #1997 on this branch is an **experimental spike**, written before this document, to
answer "does this work at all". It is not an implementation of these requirements and
should not be treated as one. It hardcodes a single model id in
`CLAUDE_MODELS`, hardcodes DeepSeek's endpoint, and makes
`hasAnyAuthForProvider`/`reservedRouteFor` treat a DeepSeek key as a Claude-provider
route — deliberately accepting the overstatement in the third open question.

**It did establish that the approach works.** A full session ran on DeepSeek V4 Flash
through the unmodified Claude Code harness: multi-step tool use, correct output, a
second dispatched turn, with `providerRouteId: claude-api-key` and no backend
credential present. That is the evidence req 1 is achievable; everything else about the
spike is scaffolding.

## Design

Settled by the 2026-08-05 answers; no part of this is deferred.

**Data model.** A user-owned list of **services** (req 10), each carrying a display
name, a credential (key *or* subscription), a base URL, the API style(s) it speaks, and
the model ids it offers. Anthropic and OpenAI are rows in that list, not special cases
(req 7). `AgentId` keeps meaning *harness* only, and gains a declared API style. The
picker's model list becomes derived — for the active harness, every model from every
configured service whose style set includes that harness's style (reqs 7–9, 11).

**Full separation is the point.** No code path should ask "which vendor's agent is
this?" to decide anything about credentials. Concretely, req 2 means a user with only a
DeepSeek key runs the Claude Code harness with no Anthropic account anywhere in the
system — so `providerAccountManager`'s per-`AgentId` account model has to become a
per-*service* one, not gain a fallback branch.

**Eligibility** (req 11) moves from `hasAnyAuthForProvider(provider)` to a per-model
question: *is there a configured service offering this model for this harness?* With
Anthropic as an ordinary service, "Claude with no account connected" and "DeepSeek with
no key" become the same condition answered by the same code. This retires the spike's
overstatement rather than patching it.

**Mid-session model switching** (req 5) is a capability question per harness, not a new
mechanism: the model is already a per-turn spawn argument, and `AgentCapabilities`
already carries per-harness flags. A switch that crosses *services* additionally
re-resolves the credential and base URL for the next spawn. What needs checking before
design is settled is whether a resident streaming process can change model without a
respawn, or whether the switch has to force one.

**Credential delivery** reuses the existing pipe: a per-service key name in
`ALLOWED_ENV_KEYS`, carried to a container by `selectAgentEnvForPush` and to local mode
by `app-di.ts`'s startup load. No new transport.

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

**Usage** (req 13) is reported per service, and the existing types are already most of
the way there: `SubscriptionLimits` is keyed by `routeId`, not by provider, because
"quota belongs to the subscription, not the provider" (its own comment) — the same
argument req 13 makes one level up. What is still per-`AgentId` is `LimitsProvider`,
which becomes per service and must accommodate a service exposing its own subscription
later without reshaping the interface again.

Note this is two distinct things, and only the first is at issue: **quota telemetry**
(`SubscriptionLimits` — plan tier, rolling and weekly windows, `usedPct`, `resetAt`,
fed by `rate_limit_event` or `/api/oauth/usage`) versus **token and cost accounting**
(`RecordedTurn` — `costUsd`, input/output tokens, cache reads, context occupancy),
which ShipIt already records per turn for every provider. A key-based service has no
quota to report but full token accounting. Req 13 keeps that slot **empty** for such a
service, which is what a key-based route already does today — so this is inherited
behavior to preserve, not new behavior to build. Putting spend in that slot is
deliberately out of scope; the data exists, but it is its own feature.

**The three known-wrong behaviors** are then not three fixes, and one is not a fix at
all: eligibility subsumes the auth-flow misfire (a 401 from a service should re-prompt
for *that service's* credential), req 12 subsumes the non-turn failures, and the "empty
usage pill" turns out to be correct behavior once the pill is per-service — a service
with no quota should show nothing. Only the first two are work.

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
