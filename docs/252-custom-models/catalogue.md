---
issue: planning#321
title: Custom models — harness and service catalogue
description: The launch inventory of harnesses and services, written as the TypeScript declarations phase 1 transcribes.
---

# 252 — Harness and service catalogue

The inventory of what ShipIt will run: every **harness** (agent CLI) and every **service**
(a credentialed source of models), in the form they take in the source tree. Companion to
[`plan.md`](./plan.md); the requirements they serve are in
[`requirements.md`](./requirements.md), chiefly req 15 (what the launch catalogue contains)
and req 6 (how a model becomes available on a harness).

This document exists so **phase 1 is transcription, not invention**. It is also the
deliverable of the third-harness survey `plan.md` schedules into phase 1: Cursor CLI and
OpenCode appear here as filled-in rows, not as integrations.

## Read this first: what is checked and what is not

Every declaration below carries one of two markers, and the difference matters more than
anything else in this file.

| Marker | Means |
|---|---|
| **✅** | Read out of this repository or verified against a running CLI. Cited with file and line. |
| **🔍** | **Not verified.** Assembled from documentation and from what the author knew, which has a training cutoff. Must be checked against the vendor's current documentation before the row is authored. |

Almost everything about Cursor CLI, OpenCode, DeepSeek, GLM, OpenRouter and Vercel is 🔍.
That is the expected state — `plan.md` already says authoring a gateway row "is research, not
recall — it must be checked against each gateway's current documentation when the row is
written, not assumed from this doc". This file is the checklist for that research, and it is
wrong to read a 🔍 row as a finding.

**No prices appear below.** Req 16 needs a price per model and phase 1 owns it, but a
plausible-looking wrong price is worse than an obvious gap: it gets copied, and it produces a
cost report that is confidently incorrect. Every model therefore ships `price: PRICE_TODO`,
which is a real constant that phase 1 must replace and that a test can fail on. See
[Pricing](#pricing) below.

## The format: TypeScript, not YAML

**Declare the catalogue in TypeScript source.** Considered and rejected: a YAML or JSON file
loaded and schema-validated at startup.

**The repo has already made this choice, consistently, and drawn the line in a place that
puts the catalogue on the TypeScript side.** Typed TS modules are what it uses for
ShipIt-owned static data — the voice catalogue (`shared/voice-catalog.ts`), the MCP OAuth
providers (`orchestrator/mcp-oauth-providers.ts`), the project templates. YAML is what it
uses for *user-authored repository configuration*, and it pays for that with a hand-written
parser, normalization, warnings and tests (`shared/shipit-config.ts`). There is no Zod or Ajv
in the dependency tree, so a YAML catalogue would not be "add a schema" — it would be "write
a second validator". The service catalogue is ShipIt-owned data reviewed as source (req 7),
which is the first category, not the second. *(This paragraph is Codex's finding from a
survey of the repo's actual static-data habits; it is a better argument than the one it
replaced, which reasoned only from `CLAUDE_MODELS`.)*

The comment argument still stands on top of it. `CLAUDE_MODELS` (`agent-registry.ts:54`) is four strings preceded by
a **forty-line comment** explaining that `claude-opus-5` is a versioned id rather than the
`opus` alias because older CLIs resolve that alias to Opus 4.7; that `haiku` is deliberately
an alias so it tracks the family; and that `claude-fable-5` is listed last because it bills
per token rather than against the plan. None of that is decoration — it is the reasoning that
stops the next person "tidying" the list into breakage. In YAML it becomes a comment no tool
reads, detached from any type, and invisible to the tests.

The rest follows from that:

- **The catalogue is small by construction.** Req 6 ships a maintained subset — "at any
  moment only a handful of models are worth using for coding" — so this is tens of rows, not
  thousands. The case for external data (non-developers editing it, changing it without a
  release) does not apply: req 7 settles that the catalogue is ShipIt's and authored by
  ShipIt's developers, so changing it is a code change either way.
- **A union type does work a schema cannot.** `serviceId` as a literal union means a typo in
  a credential lookup is a compile error, and `satisfies` checks the rows without a runtime
  validator, a loader, a `$schema`, or a parse-failure path at boot.
- **No new failure mode.** A YAML catalogue can be absent, unreadable or invalid at startup,
  which is a state to design for; a TypeScript constant cannot.

The one thing YAML would buy — editing the catalogue without a redeploy — is explicitly not
wanted. Req 14 already decided the harness set is a deployment property, and req 7 says the
same of services.

## Types

Sketched here at the level phase 1 needs; the field set is the claim, the exact file layout
is not.

```ts
/** An API wire format. A service speaks one or more; a harness speaks one or more. */
export type ApiStyle =
  | "anthropic-messages"        // POST /v1/messages
  | "openai-responses"          // POST /v1/responses
  | "openai-chat-completions";  // POST /v1/chat/completions

/** Which of a service's two possible billing arrangements a selection is under (req 5). */
export type BillingMode = "sub" | "key";

/** The identity of a selected model (req 5). Not a bare model id — the same id is
 *  reachable through several services at different prices. */
export interface ModelSelection {
  serviceId: ServiceId;
  billingMode: BillingMode;
  modelId: string;
}

export interface ModelDef {
  id: string;
  label: string;
  /** The styles this model is usable under, at this service, under this mode (req 6).
   *  A service speaking a style does not imply every model works under it. */
  styles: ApiStyle[];
  /** Per-million-token prices. See Pricing — every launch row starts at PRICE_TODO. */
  price: ModelPrice;
  contextWindow?: number;
}

export interface BillingModeDef {
  kind: BillingMode;
  /** Endpoint per style. A service can serve different styles from different hosts. */
  endpoints: Partial<Record<ApiStyle, string>>;
  /** The models this mode offers. A subscription commonly offers fewer than the key. */
  models: ModelDef[];
  /** Env var carrying the credential into the session container. Key modes only;
   *  a subscription's credential is not a string in an env var. */
  envKey?: string;
}

export interface ServiceDef {
  id: ServiceId;
  name: string;
  modes: BillingModeDef[];
  /** Retired model id → successor, per mode. The successor must be declared under the
   *  same mode AND under at least the styles the retired model was (req 13). */
  retired?: Partial<Record<BillingMode, Record<string, string>>>;
}
```

`HarnessDef` is today's `AGENT_DEFS` entry (`agent-registry.ts:151`) with the model list
removed — models come from services now — and the API style added:

```ts
export interface HarnessDef {
  id: HarnessId;              // today's AgentId
  name: string;
  binary: string;
  /** The styles this CLI can speak. A set, not a scalar — see the survey below. */
  styles: ApiStyle[];
  /** How the model, endpoint and credential reach the process. */
  spawn: SpawnShape;
  capabilities: HarnessCapabilities;  // today's AgentCapabilities minus `models`
}
```

`AgentCapabilities` (`types/agent-types.ts:61`) keeps every other field it has today —
`supportsResume`, `supportsImages`, `supportsSystemPrompt`, `supportsPermissionModes`,
`supportedPermissionModes`, `toolNames`, `reasoning`, `supportsReview`, `supportsSteering`,
`supportsCompaction`, `skillsDirName`, `skillInvocationPrefix`. **Only `models` leaves**, and
that single removal is the whole type-level content of this feature.

**`ModelDef` also absorbs two records that live apart from the model list today**, which is a
second reason a structured model entry earns its keep: display labels are a separate
`MODEL_DISPLAY_NAMES` on the *client* (`client/utils/format-model.ts:1`), and context windows
a separate `MODEL_CONTEXT_WINDOWS` on the *server* (`shared/model-windows.ts:33`, e.g.
`"claude-opus-5": 1_000_000`). Three parallel structures keyed by model id, in two layers,
that must be edited together and are not checked against each other. `label` and
`contextWindow` above collapse them — so this feature *removes* a class of drift rather than
only adding a table. `METERED_MODELS` is the third, and billing modes delete it outright.

One existing field is worth knowing about because it looks like the answer to a question
elsewhere and is not: `ProviderAccountCapabilities.models?: string[]`
(`types/domain-types/provider.ts:7`) attaches a model list to a *credential account*. It is
written with only `source` and `refreshedAt` in production and **has no reader**. If tiered
subscriptions are ever handled properly — req 5 explicitly declines to, saying the accounts
are not claimed to be equivalent — this is the seam it would grow from. It is not evidence
that they are handled today.

## Harnesses

### The survey, filled in

`plan.md` lists six assumptions a third harness could break. Here is where each candidate
lands. **Every Cursor and OpenCode cell is 🔍** — this is the state of the survey before
phase 1 runs it, not its result.

| | Claude Code ✅ | Codex ✅ | Cursor CLI 🔍 | OpenCode 🔍 |
|---|---|---|---|---|
| Binary | `claude` | `codex` | `cursor-agent` | `opencode` |
| API styles | `anthropic-messages` | `openai-responses` | **none — see below** | **many**, incl. `openai-chat-completions` |
| Model per invocation | `--model <id>` flag | **JSON-RPC `turn/start` payload**, not a flag | `-m/--model <id>` | `-m provider/model` |
| Endpoint overridable | **no seam today** | **no seam today** | **apparently not** | **config file only** |
| Raw API key works | `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` | `CURSOR_API_KEY`, **Cursor's own** | per provider, in config |
| Reasoning control | `--effort` enum | `-c model_reasoning_effort=` at spawn | unknown | `reasoningEffort` in config |
| Per-turn usage reported | `total_cost_usd` | **no dollar telemetry — stored as zero** | unknown | unknown |

Three of those cells are verified negatives, and they matter more than the positives:

- **Codex does not take the model as a process argument.** It spawns `codex app-server` and
  sends the model in the JSON-RPC `turn/start` payload
  (`codex/codex-event-handler.ts:725`, `:787`); the only model-related spawn argument is
  `-c model_reasoning_effort=…` (`codex/adapter.ts:294`). So "the model is a `--model`
  argument" is true of Claude Code and false of Codex, and `SpawnShape` needs a
  *per-turn-payload* kind alongside flag/env/config. An earlier draft of this table asserted
  `-c model=<id>`, which does not exist.
- **Neither adapter has any base-URL handling at all.** No field on `AgentRunParams`, no
  Claude flag or env assignment, no Codex provider config written, no per-invocation
  override; Codex's `config.toml` writer only replaces a ShipIt-managed MCP block
  (`codex/adapter.ts:487`). Both child environments spread `process.env`, so an ambient
  variable *could* be inherited if the CLI honours it, but ShipIt does not type, select,
  validate or shape one. This is the single largest "new seam" in phase 3 and it is being
  written from scratch, not extended.
- **Codex reports no per-turn cost.** Turns without dollar telemetry are stored at zero,
  deliberately without estimating (`ws-handlers/agent-listeners.ts:1220`). So req 16's
  reporting already has a provider that tells it nothing — which is an argument for the
  catalogue's own price table beyond the custom-service case that motivated it.

**Two rows are the ones that matter, and they break in opposite ways.**

**OpenCode contradicts "a harness speaks exactly one API style" — as predicted.** It is
multi-provider by construction: it integrates the Vercel AI SDK and the models.dev registry
and advertises 75+ providers, with providers declared in `opencode.json` carrying
`options.baseURL` and `options.apiKey`, and `--model` taking `provider_id/model_id`. So the
`AgentId → style` scalar in `plan.md` is wrong for it and the join is many-to-many. `plan.md`
flagged this as the assumption most likely wrong and most expensive to fix late, and it was
right; **requirements.md is unaffected**, because req 6 was deliberately rewritten to state
the rule as a *shared style* rather than an equality. Second breakage in the same harness:
its endpoint and credential live in a **config file**, not in flags or env, so ShipIt would
write a per-session `opencode.json` before each spawn rather than setting variables. Its
`reasoningEffort` is a config option too, and its levels come from the *provider* rather than
from the CLI — the one place ShipIt's harness-keyed reasoning model (docs/217) fits badly.

**Cursor CLI may not be a harness in this design's sense at all.** It authenticates to
Cursor's own service with `CURSOR_API_KEY`, and its model argument selects from Cursor's
lineup rather than pointing at an arbitrary endpoint. If there is no supported base-URL
override, then Cursor is a CLI permanently bound to one service — which makes it a
`(harness, service)` pair fused together, exactly the conflation this feature exists to
undo. That would not block adding it; it would mean **its service is not user-configurable**
and it contributes one fixed row rather than joining the catalogue. Worth deciding
deliberately rather than discovering in the middle of phase 3. It is also the one candidate
whose *own* billing is a subscription with a metered tier, so it would exercise req 5 from
the harness side.

Neither finding changes a requirement. Both change `plan.md`'s data shapes, which is exactly
why the survey is scheduled before the types freeze.

### Declarations

```ts
export const HARNESSES = [
  {
    id: "claude",
    name: "Claude Code",
    binary: "claude",                                    // ✅ agent-registry.ts:154
    styles: ["anthropic-messages"],                      // ✅
    spawn: {
      model: { kind: "flag", flag: "--model" },          // ✅ claude/process.ts:369
      endpoint: { kind: "env", name: "ANTHROPIC_BASE_URL" },   // 🔍 not set today; new in phase 3
      credential: { kind: "env", name: "ANTHROPIC_AUTH_TOKEN" }, // ✅ scrubbed at process.ts:31
    },
    capabilities: {
      supportsImages: true, supportsPermissionModes: true,       // ✅
      reasoning: { label: "Reasoning",
        options: ["low", "medium", "high", "xhigh", "max"] },    // ✅ verified against the CLI
      /* …unchanged from AGENT_DEFS… */
    },
  },
  {
    id: "codex",
    name: "Codex",
    binary: "codex",                                     // ✅ agent-registry.ts:186
    styles: ["openai-responses"],                        // ✅
    spawn: {
      model: { kind: "turn-payload", field: "model" },   // ✅ turn/start, NOT a flag
      endpoint: { kind: "config", key: "model_provider.base_url" },  // 🔍 no seam today
      credential: { kind: "env", name: "OPENAI_API_KEY" },          // ✅ adapter.ts:259
    },
    capabilities: {
      supportsImages: false, supportsPermissionModes: false,        // ✅
      reasoning: { label: "Reasoning effort",
        options: ["none", "minimal", "low", "medium", "high", "xhigh"] }, // ✅
      /* …unchanged… */
    },
  },
  // 🔍 Both below are SURVEY ROWS. Not installed, not integrated, not shipped.
  {
    id: "cursor",
    name: "Cursor CLI",
    binary: "cursor-agent",                              // 🔍
    styles: [],                                          // 🔍 see the survey — may be none
    spawn: {
      model: { kind: "flag", flag: "--model" },          // 🔍 `-m` documented
      endpoint: { kind: "none" },                        // 🔍 no known override
      credential: { kind: "env", name: "CURSOR_API_KEY" },  // 🔍
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    binary: "opencode",                                  // 🔍
    styles: ["anthropic-messages", "openai-responses", "openai-chat-completions"], // 🔍 many
    spawn: {
      model: { kind: "flag", flag: "--model", format: "provider/model" },  // 🔍
      endpoint: { kind: "config-file", path: "opencode.json",
                  pointer: "provider.<id>.options.baseURL" },              // 🔍
      credential: { kind: "config-file", path: "opencode.json",
                    pointer: "provider.<id>.options.apiKey" },             // 🔍
    },
  },
] as const satisfies readonly HarnessDef[];
```

Req 14 governs which of these an install *has*: Claude Code and Codex are selected by
default, the set is a deployment property, and a harness that was not installed appears
nowhere. Being listed here is not being shipped.

## Services

Req 15's launch set is Anthropic, OpenAI, DeepSeek, OpenRouter, Vercel AI Gateway and GLM.

**Model ids for Anthropic and OpenAI are ✅** — they are lifted from `CLAUDE_MODELS` and
`CODEX_MODELS`, which today's picker already runs on. **Every other model id is 🔍** and the
lists are almost certainly incomplete or stale: they are what a maintained subset would
plausibly contain, not a checked lineup.

```ts
export const SERVICES = [
  {
    id: "anthropic",
    name: "Anthropic",
    modes: [
      { kind: "sub",                                      // ✅ exists today, OAuth accounts
        endpoints: { "anthropic-messages": "https://api.anthropic.com" },
        models: [
          { id: "claude-opus-5",   label: "Opus 5",   styles: ["anthropic-messages"], price: PRICE_TODO },
          { id: "claude-sonnet-5", label: "Sonnet 5", styles: ["anthropic-messages"], price: PRICE_TODO },
          { id: "haiku",           label: "Haiku",    styles: ["anthropic-messages"], price: PRICE_TODO },
        ] },                                              // ✅ ids from CLAUDE_MODELS
      { kind: "key",
        endpoints: { "anthropic-messages": "https://api.anthropic.com" },
        envKey: "ANTHROPIC_API_KEY",
        models: [ /* the three above, plus: */
          { id: "claude-fable-5", label: "Fable 5", styles: ["anthropic-messages"], price: PRICE_TODO },
        ] },
    ],
  },
```

> **Anthropic is the worked example of why billing mode is part of the selection** (req 5),
> and it is not hypothetical — the split already exists in the repo, informally.
> `claude-fable-5` is in `CLAUDE_MODELS` but "bills per token (usage-based) rather than
> against the subscription plan limit, so it's a deliberate opt-in", and
> `ModelAgentSelector.tsx` marks it with a `$` icon from a `METERED_MODELS` set
> (`ModelAgentSelector.tsx:23` ✅ — a one-element `Set`). That set is a hand-maintained list compensating for a model
> list that cannot express billing. Under this catalogue it stops being a special case: Fable
> is simply a model the key mode offers and the subscription does not, and `METERED_MODELS`
> deletes.

```ts
  {
    id: "openai",
    name: "OpenAI",
    modes: [
      { kind: "sub",                                      // ✅ ChatGPT account auth exists today
        endpoints: { "openai-responses": "https://api.openai.com" },
        models: [
          { id: "gpt-5.6-sol",   label: "GPT-5.6 Sol",   styles: ["openai-responses"], price: PRICE_TODO },
          { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", styles: ["openai-responses"], price: PRICE_TODO },
          { id: "gpt-5.6-luna",  label: "GPT-5.6 Luna",  styles: ["openai-responses"], price: PRICE_TODO },
          { id: "gpt-5.4",       label: "GPT-5.4",       styles: ["openai-responses"], price: PRICE_TODO },
        ] },                                              // ✅ ids from CODEX_MODELS
      { kind: "key",
        endpoints: { "openai-responses": "https://api.openai.com",
                     "openai-chat-completions": "https://api.openai.com" },
        envKey: "OPENAI_API_KEY",
        models: [ /* as above */ ] },
    ],
    retired: { sub: { "gpt-5.6": "gpt-5.6-sol" },         // ✅ today's normalizeCodexModelId
               key: { "gpt-5.6": "gpt-5.6-sol" } },       //    generalized into req 13's map
  },
  {
    id: "deepseek",
    name: "DeepSeek",                                     // 🔍 ENTIRE ROW
    modes: [
      { kind: "key",                                      // no subscription exists
        endpoints: { "openai-chat-completions": "https://api.deepseek.com",
                     "openai-responses": "https://api.deepseek.com",
                     "anthropic-messages": "https://api.deepseek.com/anthropic" },
        envKey: "DEEPSEEK_API_KEY",
        models: [
          // Only V4 Flash is supported under Codex — the spike's finding, and the
          // founding example of why req 6 declares models per style (plan.md, Appendix A).
          { id: "deepseek-v4-flash", label: "V4 Flash",
            styles: ["openai-chat-completions", "openai-responses", "anthropic-messages"],
            price: PRICE_TODO },
          { id: "deepseek-v4-pro", label: "V4 Pro",
            styles: ["openai-chat-completions", "anthropic-messages"], price: PRICE_TODO },
        ] },
    ],
  },
  {
    id: "zai",
    name: "GLM (Z.ai)",                                   // 🔍 ENTIRE ROW
    modes: [
      { kind: "sub", /* the coding plan — phase 2 owns this integration */
        endpoints: { "anthropic-messages": "…" },
        models: [ /* fewer than the key offers — that asymmetry is the point */ ] },
      { kind: "key",
        endpoints: { "openai-chat-completions": "…", "anthropic-messages": "…" },
        envKey: "ZAI_API_KEY",
        models: [ /* … */ ] },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",                                   // 🔍 ENTIRE ROW
    modes: [
      { kind: "key",
        // Speaks an Anthropic Messages endpoint AND OpenAI-style ones — verified during
        // the spike (plan.md, Appendix A), which corrected an earlier draft that had
        // only DeepSeek serving an Anthropic surface.
        endpoints: { "openai-chat-completions": "https://openrouter.ai/api/v1",
                     "anthropic-messages": "https://openrouter.ai/api/v1" },
        envKey: "OPENROUTER_API_KEY",
        models: [ /* a maintained subset of the upstream catalogue, req 6 */ ] },
    ],
  },
  {
    id: "vercel",
    name: "Vercel AI Gateway",                            // 🔍 ENTIRE ROW
    modes: [
      { kind: "key",
        endpoints: { "openai-chat-completions": "…" },
        envKey: "VERCEL_AI_GATEWAY_KEY",
        models: [ /* … */ ] },
    ],
  },
] as const satisfies readonly ServiceDef[];
```

### What the join produces

Worth stating because it is the feature's whole output. With every service credentialed:

- **Claude Code** (`anthropic-messages`) offers Anthropic's models, both DeepSeek models,
  GLM's, and OpenRouter's — the last because OpenRouter serves an Anthropic Messages endpoint
  alongside its OpenAI-style ones, which the spike verified after an earlier draft assumed
  only DeepSeek did.
- **Codex** (`openai-responses`) offers OpenAI's models and DeepSeek's `deepseek-v4-flash` —
  but **not** `deepseek-v4-pro`, which DeepSeek does not support under Codex. That single
  exclusion is the founding example of req 6: a purely derived rule would list the pair and
  let the turn fail at the wire format.

Two things fall out of this that are worth telling whoever authors the rows. First,
`deepseek-v4-pro` on Claude Code but not on Codex is not a mistake to be tidied away — it is
the reason the per-model declaration exists, and the case any refactor must keep expressible.
Second, **`openai-chat-completions` has no harness at all** in the launch set: both shipped
CLIs speak the other two styles, so the most widely-supported wire format in the industry is
declared and unreachable. It costs nothing to carry, and it is what OpenCode would light up
the moment it arrived — which is a better argument for surveying OpenCode now than any of the
type-shape ones.

## Pricing

Req 16 reports what was spent per service and billing mode, and what subscription usage would
have cost at API rates. Neither number can come from the harness: `total_cost_usd` is the
CLI's own price table applied to whatever model *it* thinks it is running — measured, in
`plan.md`, as a constant 18× on real turns. So ShipIt needs its own table, keyed by
`(service, mode, model)`, which is the `price` field above.

```ts
export interface ModelPrice {
  input: number;       // USD per million input tokens
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Sentinel for a row whose price has not been checked. Phase 1 replaces every one.
 *  A catalogue test asserts no shipped row still carries it. */
export const PRICE_TODO: ModelPrice = { input: -1, output: -1 };
```

Negative sentinels rather than zeros, deliberately: a zero price is a *plausible* price
(subscription models genuinely cost nothing extra) and would flow into req 16's report as a
real "$0.00". A negative one cannot be mistaken for an answer and shows up immediately if the
test is ever weakened.

`plan.md` already records the standing risk: per-model pricing is a real widening of what a
catalogue row costs to maintain, prices move more often than model lists do, and if the
upkeep proves unacceptable the thing to drop is req 16's cost figures rather than to scatter
a second price source elsewhere.

## What phase 1 must check before authoring

Every 🔍 above, but these are the ones whose answers change the *shape* rather than the
contents:

1. **Does Cursor CLI support a base-URL override?** If not, it is a CLI bound to one service
   and joins the catalogue as a fused pair rather than as a harness.
2. **How many API styles does OpenCode speak, and does ShipIt drive it through a written
   `opencode.json`?** If yes, `SpawnShape` needs a config-file writer, and per-session config
   generation is a new spawn-path concern.
3. **Does DeepSeek's Anthropic-compatible endpoint accept every model, or only some?** The
   asymmetry above is the founding example of req 6 and it should be a checked fact.
   Likewise **do OpenRouter or Vercel speak the Responses API**, which is what decides
   whether a gateway can reach Codex at all.
4. **What does GLM's coding plan actually offer, and how does its auth work?** Phase 2 owns
   the integration, and req 15 is unmet until it lands.
5. **Do OpenRouter or Vercel speak anything beyond chat-completions?** If either serves an
   Anthropic-compatible or Responses endpoint, the join widens considerably.
