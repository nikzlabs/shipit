---
issue: https://linear.app/shipit-ai/issue/SHI-319
title: Custom models
description: Run a session on a model the agent backend's vendor did not make, reusing the existing harness rather than adding a backend.
---

# 252 — Custom models

Implements [`requirements.md`](./requirements.md). **Open questions in that document
block implementation**; the sections below marked _Deferred_ are the ones whose shape
those answers decide.

## The idea

ShipIt integrates **harnesses**, not models. `AgentProcess` spawns a CLI and
normalizes its event stream; the model is a `--model` argument that CLI forwards to
an API. So running a different vendor's model does not need a new backend — it needs
the same CLI pointed at a different endpoint (req 1, req 2).

That is the whole mechanism, and it is why this is cheap. Everything expensive in an
agent integration — the tool map, the event parsing, skills disclosure, MCP config,
steering, permission modes, plan mode — belongs to the harness and is untouched
(req 4).

## The actual problem: `AgentId` conflates harness and provider

`AgentId` (`"claude" | "codex"`) is used as three different things at once:

- **which CLI binary to spawn** — `AGENT_DEFS[].binary`, `createWorkerAgent()`
- **which credential authenticates it** — `providerAccountManager`, the auth managers
- **which models are offered** — `AGENT_DEFS[].capabilities.models`

A custom model keeps the first, replaces the second, and extends the third. There is
no way to say that today, and every awkwardness below is a symptom of that single
gap. Resolving it is the real work; DeepSeek is just the first case that forces it.

## Findings from the spike

All verified against the code on this branch, not inferred.

### The credential pipe already exists, end to end

`CredentialStore.agentEnv` → `selectAgentEnvForPush` (`session-agent-env.ts:217`) →
`PUT /secrets` on the worker → worker `process.env` → `spawnEnv = {...process.env}`.
Gated by one predicate, `isAllowedAgentEnvKey` (`agent-registry.ts:314`). Adding a key
name to `ALLOWED_ENV_KEYS` covers **both** delivery paths — containerized sessions via
the push above, local mode via `app-di.ts:421`'s startup load into `process.env`
(req 5).

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

### Providers: compatibility, not availability, is the constraint

DeepSeek V4 Flash is served by DeepSeek, DeepInfra, Parasail, Fireworks and
SiliconFlow, aggregated by OpenRouter, plus open weights for self-hosting. But only
DeepSeek's own `/anthropic` surface is **Anthropic-compatible**; the rest are
OpenAI-compatible, so pointing the Claude Code CLI at them fails at the wire format,
not at auth. Switching provider is therefore not a URL swap — it needs a translating
gateway. This is the substance of the first open question.

### Three things break, all from the same root

1. **The usage pill is empty.** `ClaudeLimitsProvider` is event-fed from
   `agent_rate_limits`, which a custom provider does not emit.
2. **A 401 triggers the wrong recovery.** `AUTH_ERROR_PATTERNS` (`process.ts:43`)
   matches `"unauthorized"` / `"authentication_error"`, so a bad custom key kicks the
   session into the *backend vendor's* OAuth re-auth flow, which cannot fix it.
3. **Non-turn CLI spawns fail.** Session naming and PR-description generation spawn
   the CLI outside the turn path, so they get no custom routing and no backend
   credential. Observed as `[session-namer] claude CLI failed`; sessions fall back to a
   truncated-prompt title.

Each is code that assumes a provider identity the type system cannot express — the
same gap as above, surfacing three times. None should be patched individually.

### Prompt caching is not portable

`PRECOMPUTED_INSTRUCTIONS` renders every prompt variant once at module load
specifically to keep the CLI string byte-stable for Anthropic's prompt cache. A custom
provider has its own cache semantics, so cost and latency on a custom model are not
comparable to the tuned path, in either direction.

## Relationship to the spike

PR #1997 on this branch is an **experimental spike**, written before this document, to
answer "does this work at all" (req 7). It is not an implementation of these
requirements and should not be treated as one. It hardcodes a single model id in
`CLAUDE_MODELS`, hardcodes DeepSeek's endpoint, and makes
`hasAnyAuthForProvider`/`reservedRouteFor` treat a DeepSeek key as a Claude-provider
route — deliberately accepting the overstatement in the third open question.

**It did establish that the approach works.** A full session ran on DeepSeek V4 Flash
through the unmodified Claude Code harness: multi-step tool use, correct output, a
second dispatched turn, with `providerRouteId: claude-api-key` and no backend
credential present. That is the evidence req 1 is achievable; everything else about the
spike is scaffolding.

## Design

_Deferred._ The shape depends on all five open questions — in particular whether custom
models are user-configured or code-listed, which decides whether this is a data model
plus settings surface or a registry widening. Writing it now would make the design a
second, hidden source of requirements.

What is already known to be in scope regardless:

- A way to express "this model runs on this harness with this credential and endpoint",
  replacing the `AgentId`-as-provider assumption.
- Model-level (not provider-level) route eligibility.
- Credential delivery via the existing `ALLOWED_ENV_KEYS` pipe.
- Env shaping at both spawn sites, after the scrub.

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

## Verifying a custom model without shipping it

Requirement 7's path, as exercised: declare the credential in the `dev` service's
`x-shipit-secrets`, set it in the **outer** Settings → Secrets, `shipit service restart dev`
(a running service does not pick up a newly declared secret), then drive the inner
instance over its API — `POST /api/sessions/headless` with `model`, then
`/agent/dispatch`, `/status`, `/history`.

**What this does not prove:** local mode spawns agents in-process and never exercises
the container path (`session-worker.ts:742`). A green dogfood run shows the model and
the stream parsing work; it does not validate a containerized session.
