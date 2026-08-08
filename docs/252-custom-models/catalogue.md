---
issue: planning#321
title: Custom models — harness and service catalogue
description: The launch inventory of harnesses and services, written as the TypeScript declarations phase 1 transcribes.
---

# 252 — Harness and service catalogue

The inventory of what ShipIt will run: every **harness** (agent CLI) and every **service**
(a credentialed source of models), in the form they take in the source tree. Companion to
[`plan.md`](./plan.md); the requirements they serve are in
[`requirements.md`](./requirements.md), chiefly req 15 (what the launch catalogue contains),
req 6 (how a model becomes available on a harness), req 13 (retirement) and req 16 (cost).

This document exists so **phase 1 is transcription, not invention**. It is also where the
third-harness survey's rows live; the *consequences* of that survey for the design are in
`plan.md`'s [What a third harness could break](./plan.md#what-a-third-harness-could-break),
not repeated here.

## Read this first: what is checked and what is not

Every declaration carries one of two markers, and the difference matters more than anything
else in this file.

| Marker | Means |
|---|---|
| **✅** | Read out of this repository, cited with file and line. |
| **🔍** | **Not verified.** From documentation, from prior notes, or from what the author knew — and the author has a training cutoff. To be checked before the row is authored. |

Two disciplines follow from that, both of which an earlier draft broke:

- **A ✅ covers exactly what the citation proves, and no inference from it.** The repo can
  show that ShipIt passes `--model` to the `claude` binary; it cannot show what wire format
  that binary speaks to an endpoint ShipIt has never pointed it at. The second is 🔍 even
  though it is very likely true.
- **🔍 prose is written as a hypothesis, not a finding.** If the row is unverified, the
  paragraph explaining it says "appears to" and not "contradicts".

Everything about Cursor CLI, OpenCode, DeepSeek, GLM, OpenRouter and Vercel is 🔍. That is
the expected state — `plan.md` already says authoring a gateway row "is research, not recall".
This file is the checklist for that research.

**No prices appear.** See [Pricing](#pricing).

## The format: TypeScript, not YAML

**Declare the catalogue in TypeScript source.** The repo has already drawn this line, and
drawn it in the place that puts the catalogue on the TypeScript side: typed TS modules are
what it uses for **ShipIt-owned static data** — the voice catalogue
(`shared/voice-catalog.ts`), the MCP OAuth providers (`orchestrator/mcp-oauth-providers.ts`),
the project templates. YAML is what it uses for **user-authored repository configuration**,
and it pays for that with a hand-written parser, normalization, warnings and tests
(`shared/shipit-config.ts`). The service catalogue is ShipIt-owned data reviewed as source
(req 7) — the first category.

Two smaller arguments on top:

- **Compile-time typing does work no loader would.** `ServiceId` as a literal union means a
  typo in a credential lookup is a compile error, and `satisfies` checks the rows without a
  runtime validation layer or a parse-failure path at boot.
- **The reasoning survives next to the data.** `CLAUDE_MODELS` (`agent-registry.ts:54` ✅) is
  four strings under a forty-line comment explaining which ids are CLI aliases and which are
  pinned versions, and why — the reasoning that stops the list being "tidied" into breakage.

*(An earlier draft argued this partly from "there is no Zod or Ajv in the dependency tree".
That is false — `zod@4.4.3` arrives via the MCP SDK and `ajv@8.18.0` via the MCP SDK, Fastify
and ESLint. The ownership distinction above is the argument that holds.)*

## Types

```ts
/** An API wire format. Both services and harnesses hold a SET of these. */
export type ApiStyle =
  | "anthropic-messages"        // POST /v1/messages
  | "openai-responses"          // POST /v1/responses
  | "openai-chat-completions";  // POST /v1/chat/completions

export type BillingMode = "sub" | "key";

export type ServiceId = (typeof SERVICES)[number]["id"];
export type HarnessId = (typeof HARNESSES)[number]["id"];

/** The identity of a selected model (req 5) — never a bare model id. */
export interface ModelSelection {
  serviceId: ServiceId;
  billingMode: BillingMode;
  modelId: string;
}

export interface ModelDef {
  id: string;
  label: string;
  /** Styles this model is usable under, at this service, under this mode (req 6). */
  styles: ApiStyle[];
  /** ALWAYS the service's API rate. See Pricing — never the incremental cost. */
  price: ModelPrice;
  contextWindow: number;
}

export interface BillingModeDef {
  kind: BillingMode;
  endpoints: Partial<Record<ApiStyle, string>>;
  models: ModelDef[];
  /** How a credential for THIS MODE reaches the CLI. Not a harness property — see below. */
  credential: CredentialShape;
  retired: RetiredModel[];
}

export interface ServiceDef {
  id: string;
  name: string;
  modes: BillingModeDef[];
}
```

`ServiceId` and `HarnessId` are **derived from the constants**, not declared ahead of them —
which is what makes the literal-union claim above real rather than aspirational, and avoids
the circular declaration of naming the ids twice.

### Retirement carries the retired model's styles

Req 13's successor must be in the same service, the same billing mode, **and runnable on the
session's pinned harness**. A bare `oldId → newId` map cannot enforce the third: once the
retired model is gone from `models`, the styles it was declared under are gone with it, so
there is nothing left to compare the successor against. It also cannot express a retirement
whose successor differs by style.

```ts
export interface RetiredModel {
  id: string;
  /** The styles the retired model was declared under. Kept precisely because the model
   *  itself is gone — this is the record the successor check compares against. */
  styles: ApiStyle[];
  /** Successor per style. Usually one id repeated; occasionally not. Every style in
   *  `styles` must appear here, and each successor must be a current model of this
   *  mode declared under that style. A catalogue test enforces both (req 13). */
  successors: Partial<Record<ApiStyle, string>>;
}
```

This is the shape `plan.md` left open between two candidates. It is the more explicit of the
two: the invariant is checkable from the row alone, at authoring time, without consulting the
history of what the model used to be.

### Credentials belong to the billing mode, not the harness

An earlier draft put one `credential` on each harness. That is wrong, and both shipped
harnesses disprove it — each authenticates *differently depending on the billing mode*:

- **Claude** — a subscription account uses credential files under a scoped `HOME`, and
  `scrubEnvAuthForScopedHome` **deletes** `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from
  the child environment precisely so the CLI reads those files (`claude/process.ts:12` ✅).
  The env vars are the *reserved-route* path, not the general one.
- **Codex** — a subscription uses `~/.codex/auth.json` and the adapter deletes
  `OPENAI_API_KEY`; key mode uses that variable (`codex/adapter.ts:259` ✅).

So credential delivery is a function of `(harness, billing mode)`, and the mode is where it
is declared:

```ts
export type CredentialShape =
  | { kind: "env"; name: string }            // key modes: a token in the environment
  | { kind: "scoped-home" };                 // subscription modes: files under HOME
```

### How a harness is spawned

```ts
export type SpawnShape = {
  /** How the model id reaches the process. The two shipped harnesses differ. */
  model:
    | { kind: "flag"; flag: string }                 // Claude: --model <id>
    | { kind: "turn-payload"; field: string };       // Codex: JSON-RPC turn/start
  /** How the endpoint is overridden. `none` means the harness offers no way. */
  endpoint:
    | { kind: "env"; name: string }
    | { kind: "config-file"; path: string; pointer: string }
    | { kind: "none" };
};

export interface HarnessDef {
  id: string;
  name: string;
  binary: string;
  /** A SET, not a scalar — see the survey. The service×harness join is an intersection. */
  styles: ApiStyle[];
  spawn: SpawnShape;
  capabilities: Omit<AgentCapabilities, "models">;
}
```

`AgentCapabilities` (`types/agent-types.ts:61` ✅) keeps every field it has today —
`supportsResume`, `supportsImages`, `supportsSystemPrompt`, `supportsPermissionModes`,
`supportedPermissionModes`, `toolNames`, `reasoning`, `supportsReview`, `supportsSteering`,
`supportsCompaction`, `skillsDirName`, `skillInvocationPrefix`. **Only `models` leaves**, and
that single removal is the whole type-level content of this feature. Note `reasoning.options`
is `{ value, label }[]` (`agent-types.ts:29` ✅), not a bare `string[]`.

**`ModelDef` also absorbs two records that live apart from the model list today.** Display
labels are a `MODEL_DISPLAY_NAMES` record on the *client* (`client/utils/format-model.ts:1`
✅); context windows a `MODEL_CONTEXT_WINDOWS` record on the *server*
(`shared/model-windows.ts:33` ✅). With `METERED_MODELS`
(`ModelAgentSelector.tsx:23` ✅) that is three parallel structures keyed by model id, across
two layers, edited by hand together and checked against nothing. `label`, `contextWindow` and
billing modes collapse all three — so this feature removes a class of drift rather than only
adding a table. **`contextWindow` is therefore required, not optional**: dropping it would
regress today's first-frame windows (Claude 1M, Codex 272K).

## Harnesses

### The survey

`plan.md` lists six assumptions a third harness could break. **Every Cursor and OpenCode cell
below is 🔍** — this is the state of the survey before phase 1 runs it, not its result.

| | Claude Code | Codex | Cursor CLI 🔍 | OpenCode 🔍 |
|---|---|---|---|---|
| Binary | `claude` ✅ | `codex` ✅ | `cursor-agent` | `opencode` |
| API styles it speaks to a remote endpoint | `anthropic-messages` 🔍 | `openai-responses` 🔍 | unclear — see below | many, incl. `openai-chat-completions` |
| Model per invocation | `--model` flag ✅ | JSON-RPC `turn/start` payload ✅ | `-m/--model <id>` | `-m provider/model` |
| Endpoint overridable | **no seam today** ✅ | **no seam today** ✅ | apparently not | config file only |
| Subscription auth | scoped-home files ✅ | `~/.codex/auth.json` ✅ | n/a | n/a |
| Key auth | `ANTHROPIC_API_KEY` ✅ | `OPENAI_API_KEY` ✅ | `CURSOR_API_KEY`, Cursor's own | per provider, in config |
| Reasoning control | `--effort` enum ✅ | `-c model_reasoning_effort=` ✅ | unknown | `reasoningEffort` in config |
| Per-turn cost reported | `total_cost_usd` ✅ | **none — stored as zero** ✅ | unknown | unknown |

**The API-style row is 🔍 for all four columns, including the two shipped ones.** This looks
pedantic and is not: the repository proves how ShipIt drives a *local* CLI, never what wire
format that CLI would use against a redirected endpoint. Codex is a case in point — ShipIt
speaks JSON-RPC to `codex app-server`, which says nothing about whether an arbitrary provider
gets driven through the Responses API. Since the whole join rests on this row, it is the
first thing phase 3 should establish empirically rather than the thing everything else
assumes.

**Three verified negatives matter more than the positives:**

- **Neither adapter has any base-URL handling.** No field on `AgentRunParams`, no Claude flag
  or env assignment, no Codex provider config written, no per-invocation override; Codex's
  `config.toml` writer only replaces a ShipIt-managed MCP block (`codex/adapter.ts:487` ✅).
  Phase 3 writes this seam from scratch.
- **The two shipped harnesses take the model by different mechanisms** — a process flag and a
  turn payload — so "set the model" is two implementations.
- **Codex reports no per-turn cost.** Turns without dollar telemetry are stored at zero,
  deliberately without estimating (`ws-handlers/agent-listeners.ts:1220` ✅). Req 16 therefore
  already has a provider that tells it nothing, which argues for the catalogue's own price
  table beyond the custom-service case that motivated it.

### Shipped harnesses

```ts
export const HARNESSES = [
  {
    id: "claude",
    name: "Claude Code",
    binary: "claude",                                       // ✅ agent-registry.ts:154
    styles: ["anthropic-messages"],                         // 🔍 see the survey note
    spawn: {
      model: { kind: "flag", flag: "--model" },             // ✅ claude/process.ts:369
      endpoint: { kind: "env", name: "ANTHROPIC_BASE_URL" }, // 🔍 no seam today
    },
    capabilities: { /* today's AGENT_DEFS entry, minus `models` */ },
  },
  {
    id: "codex",
    name: "Codex",
    binary: "codex",                                        // ✅ agent-registry.ts:186
    styles: ["openai-responses"],                           // 🔍 see the survey note
    spawn: {
      model: { kind: "turn-payload", field: "model" },      // ✅ codex-event-handler.ts:725
      endpoint: { kind: "config", key: "model_provider.base_url" }, // 🔍 no seam today
    },
    capabilities: { /* today's AGENT_DEFS entry, minus `models` */ },
  },
] as const satisfies readonly HarnessDef[];
```

### Survey candidates — not shipped, not integrated

Deliberately a **separate constant**. These are notes about CLIs ShipIt does not run; putting
them in `HARNESSES` would give phase 1 rows that look installable and have no honest
`capabilities` to declare. Req 14 governs what an install actually has.

```ts
/** 🔍 ENTIRELY UNVERIFIED. Survey notes for docs/252's third-harness question.
 *  Not a harness list — nothing reads this, and nothing should until a row graduates. */
export const SURVEY_CANDIDATES = [
  { id: "cursor", binary: "cursor-agent", styles: "unclear",
    endpoint: "no known override", credential: "CURSOR_API_KEY, Cursor's own service" },
  { id: "opencode", binary: "opencode", styles: "many (Vercel AI SDK + models.dev)",
    endpoint: "opencode.json → provider.<id>.options.baseURL",
    credential: "opencode.json → provider.<id>.options.apiKey" },
] as const;
```

Two things they *appear* to show, both of which phase 1 must confirm and neither of which
changes a requirement — the design consequences are worked through in `plan.md`:

- **OpenCode appears to speak many API styles**, which is why `HarnessDef.styles` is a set.
- **Cursor CLI appears to be bound to Cursor's own service**, which would make it a fused
  `(harness, service)` pair rather than a harness that joins the catalogue.

## Services

Req 15's launch set: Anthropic, OpenAI, DeepSeek, OpenRouter, Vercel AI Gateway, GLM.

**Model ids, labels and context windows for Anthropic and OpenAI are ✅**, lifted from
`CLAUDE_MODELS`, `CODEX_MODELS`, `MODEL_DISPLAY_NAMES` and `MODEL_CONTEXT_WINDOWS`. Phase 1's
review criterion is that the picker offers *exactly* today's models, so these lists are
complete rather than illustrative. **Which mode offers which is 🔍** — see the note after
Anthropic.

```ts
const A_MSG = "anthropic-messages", O_RESP = "openai-responses", O_CC = "openai-chat-completions";

export const SERVICES = [
  {
    id: "anthropic",
    name: "Anthropic",
    modes: [
      { kind: "sub",                                       // ✅ OAuth accounts exist today
        endpoints: { [A_MSG]: "https://api.anthropic.com" },
        credential: { kind: "scoped-home" },               // ✅ claude/process.ts:12
        retired: [],
        models: [
          { id: "claude-opus-5",   label: "Opus 5",   styles: [A_MSG], contextWindow: 1_000_000, price: PRICE_TODO },
          { id: "claude-sonnet-5", label: "Sonnet 5", styles: [A_MSG], contextWindow: 1_000_000, price: PRICE_TODO },
          { id: "haiku",           label: "Haiku 4.5", styles: [A_MSG], contextWindow: 200_000, price: PRICE_TODO },
        ] },
      { kind: "key",
        endpoints: { [A_MSG]: "https://api.anthropic.com" },
        credential: { kind: "env", name: "ANTHROPIC_API_KEY" },   // ✅
        retired: [],
        models: [
          { id: "claude-opus-5",   label: "Opus 5",   styles: [A_MSG], contextWindow: 1_000_000, price: PRICE_TODO },
          { id: "claude-sonnet-5", label: "Sonnet 5", styles: [A_MSG], contextWindow: 1_000_000, price: PRICE_TODO },
          { id: "haiku",           label: "Haiku 4.5", styles: [A_MSG], contextWindow: 200_000, price: PRICE_TODO },
          { id: "claude-fable-5",  label: "Fable 5",  styles: [A_MSG], contextWindow: 1_000_000, price: PRICE_TODO },
        ] },
    ],
  },
```

> **Fable's placement is 🔍, and it is the one asymmetry above that is not lifted from the
> repo.** What the repo shows is that ShipIt marks `claude-fable-5` metered — a one-element
> `METERED_MODELS` set (`ModelAgentSelector.tsx:23` ✅) and a comment saying it "bills per
> token (usage-based) rather than against the subscription plan limit". That is a billing
> statement, not proof that a subscription credential cannot run it, and the two are
> different claims. Verify before authoring. If it holds, Anthropic becomes the worked
> example of req 5 — a model the key offers and the subscription does not — and
> `METERED_MODELS` deletes, replaced by a fact the type can express. If it does not hold,
> Fable belongs in both modes at different prices, which req 5 handles equally well.

```ts
  {
    id: "openai",
    name: "OpenAI",
    modes: [
      { kind: "sub",                                       // ✅ ChatGPT account auth today
        endpoints: { [O_RESP]: "https://api.openai.com" },
        credential: { kind: "scoped-home" },               // ✅ ~/.codex/auth.json
        retired: [
          { id: "gpt-5.6", styles: [O_RESP], successors: { [O_RESP]: "gpt-5.6-sol" } },
        ],                                                 // ✅ today's normalizeCodexModelId
        models: [
          { id: "gpt-5.6-sol",   label: "GPT-5.6 Sol",   styles: [O_RESP], contextWindow: 272_000, price: PRICE_TODO },
          { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", styles: [O_RESP], contextWindow: 272_000, price: PRICE_TODO },
          { id: "gpt-5.6-luna",  label: "GPT-5.6 Luna",  styles: [O_RESP], contextWindow: 272_000, price: PRICE_TODO },
          { id: "gpt-5.5",       label: "GPT-5.5",       styles: [O_RESP], contextWindow: 272_000, price: PRICE_TODO },
          { id: "gpt-5.4",       label: "GPT-5.4",       styles: [O_RESP], contextWindow: 272_000, price: PRICE_TODO },
          { id: "gpt-5.4-mini",  label: "GPT-5.4 Mini",  styles: [O_RESP], contextWindow: 272_000, price: PRICE_TODO },
          { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", styles: [O_RESP], contextWindow: 272_000, price: PRICE_TODO },
          { id: "gpt-5.2",       label: "GPT-5.2",       styles: [O_RESP], contextWindow: 272_000, price: PRICE_TODO },
        ] },                                               // ✅ all eight, in CODEX_MODELS order
      { kind: "key",
        endpoints: { [O_RESP]: "https://api.openai.com", [O_CC]: "https://api.openai.com" },
        credential: { kind: "env", name: "OPENAI_API_KEY" },   // ✅ codex/adapter.ts:259
        retired: [ /* the same gpt-5.6 entry */ ],
        models: [ /* the same eight; styles gain O_CC — 🔍 which of them the key serves */ ] },
    ],
  },
```

> **Order is load-bearing** and survives into the catalogue: `models[0]` is what a fresh
> install runs (`agent-registry.ts` ✅, and the client's `activeAgent?.models[0]` fallback).
> Under the triple the default becomes the first model of the first service and mode (req 9),
> so the ordering *within* a mode still decides it.

```ts
  {
    id: "deepseek", name: "DeepSeek",                      // 🔍 ENTIRE ROW
    modes: [
      { kind: "key",                                       // no subscription exists
        endpoints: { [O_CC]: "https://api.deepseek.com", [O_RESP]: "https://api.deepseek.com",
                     [A_MSG]: "https://api.deepseek.com/anthropic" },
        credential: { kind: "env", name: "DEEPSEEK_API_KEY" },
        retired: [],
        models: [
          // Only V4 Flash is believed supported under Codex — the founding example of
          // why req 6 declares models per style rather than deriving them.
          { id: "deepseek-v4-flash", label: "V4 Flash", styles: [O_CC, O_RESP, A_MSG], contextWindow: 0, price: PRICE_TODO },
          { id: "deepseek-v4-pro",   label: "V4 Pro",   styles: [O_CC, A_MSG],         contextWindow: 0, price: PRICE_TODO },
        ] },
    ],
  },
  {
    id: "zai", name: "GLM (Z.ai)",                         // 🔍 ENTIRE ROW
    modes: [
      { kind: "sub",   /* the coding plan — phase 2 owns this integration */ },
      { kind: "key",   /* offers more models than the plan — that asymmetry is the point */ },
    ],
  },
  { id: "openrouter", name: "OpenRouter", /* 🔍 key mode; a maintained subset, req 6 */ },
  { id: "vercel", name: "Vercel AI Gateway", /* 🔍 key mode */ },
] as const satisfies readonly ServiceDef[];
```

### One consequence worth naming

**`openai-chat-completions` has no harness at all** in the launch set: both shipped CLIs
speak the other two styles, so the industry's most widely supported wire format is declared
and unreachable. It costs nothing to carry, and it is what a multi-provider harness would
light up on arrival — a better argument for surveying OpenCode now than any of the type-shape
ones.

Beyond that, which harness reaches which service is a **derived** fact this document should
not restate: it falls out of the join, it depends on API-style rows that are 🔍 for every
column, and a test over the real declarations will assert it without drifting. An earlier
draft enumerated the pairings in prose and had already gone stale once.

## Pricing

Req 16 reports what was spent per service and billing mode, and what subscription usage
**would have cost at that service's API rates**. Neither number can come from the harness:
`total_cost_usd` is the CLI's own price table applied to whatever model *it* thinks it is
running — measured, in `plan.md`, as a constant 18× on real turns — and Codex reports no
dollar figure at all.

```ts
export interface ModelPrice {
  input: number;       // USD per million input tokens
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Sentinel for a row whose price has not been checked. Phase 1 replaces every one;
 *  a catalogue test asserts no shipped row still carries it. */
export const PRICE_TODO: ModelPrice = { input: -1, output: -1 };
```

**`price` is always the service's API rate for that model — never the incremental cost of a
turn.** The billing mode decides what the rate is *used for*: under a key it is what the user
paid, under a subscription it is req 16's "would have cost" comparison. This is the one
definition that serves both halves of req 16, and it is why a subscription row still carries
a non-zero price even though its turns cost nothing extra. An earlier draft had it the other
way round and justified the sentinel by arguing that "zero is a plausible price, because
subscription models genuinely cost nothing extra" — under which req 16's comparison would
have reported every subscription as free, which is exactly the number it exists to produce.

The sentinel is negative rather than zero so that a forgotten row is loud. The table is keyed
`(service, mode, model)`, because a service's two modes can price the same model differently.

`plan.md` records the standing risk: per-model pricing widens what a catalogue row costs to
maintain, prices move more often than model lists do, and if the upkeep proves unacceptable
the thing to drop is req 16's cost figures rather than to scatter a second price source.

## What phase 1 must check before authoring

Every 🔍, but these change the *shape* rather than the contents:

1. **What wire format does each harness actually speak to a redirected endpoint?** 🔍 for all
   four candidates, and the whole join rests on it.
2. **Does Cursor CLI support a base-URL override?** If not it is a fused `(harness, service)`
   pair rather than a harness.
3. **Does driving OpenCode mean writing a per-session `opencode.json`?** If so, `SpawnShape`
   needs a config-file writer and per-session config generation is a new spawn-path concern.
4. **Is `claude-fable-5` genuinely unavailable under an Anthropic subscription?** Today's
   `METERED_MODELS` asserts metered billing, not exclusion.
5. **Which DeepSeek models does its Anthropic-compatible endpoint serve, and do OpenRouter or
   Vercel speak the Responses API?** The second decides whether a gateway can reach Codex.
6. **What does GLM's coding plan offer, and how does its auth work?** Phase 2 owns the
   integration and req 15 is unmet until it lands.
