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

This document settles **the types, and the rows that this repository can settle** — the
Anthropic and OpenAI inventories are written out in full, because phase 1's review criterion
is that the picker offers exactly what it offers today.

It is not a finished catalogue and does not claim to be. The 🔍 rows are research first: GLM,
OpenRouter and Vercel are named with their contents deliberately open, since req 6's
maintained subset is a judgement made when a row is authored.

**One shape question stays open on purpose**: how a harness fused to its own service (Cursor)
would be represented, since no requirement commits to that harness and inventing a shape for
it would be speculative. The other one is closed — `SpawnShape` already carries the
config-file case for endpoint and credential, and `CredentialTargets.key` is optional so an
OAuth-only CLI narrows the join instead of failing at spawn. Neither of the two shipped
harnesses is affected by either.

**The survey stays in this document.** It was asked for, and deleting it to make the launch
types look more settled would trade a real benefit for a cosmetic one: the whole reason to
survey now is that these types freeze in phase 1, and a candidate that contradicts them is
cheaper to hear about before then. Carrying an open question honestly is not the same as
leaving the design unsettled — the axes are settled, and the survey can only add a variant to
a union that already has three.

It is also where the
third-harness survey's rows live; the *consequences* of that survey for the design are in
`plan.md`'s [What a third harness could break](./plan.md#what-a-third-harness-could-break),
not repeated here.

## Read this first: what is checked and what is not

Every declaration that makes a **claim about the world** carries one of two markers, and the
difference matters more than anything else in this file. Structural fields — an endpoint
string, a label, the shape of a row — carry a marker only where they assert something
checkable.

| Marker | Means |
|---|---|
| **✅** | Read out of this repository, cited with file and line. |
| **🔍** | **Not verified.** From documentation, from prior notes, or from what the author knew — and the author has a training cutoff. To be checked before the row is authored. |

Two disciplines follow, and both have been broken here before:

- **A ✅ covers exactly what the citation proves, and no inference from it.** The repo can
  show that ShipIt passes `--model` to the `claude` binary; it cannot show what wire format
  that binary speaks to an endpoint ShipIt has never pointed it at. The second is 🔍 even
  though it is very likely true.
- **🔍 prose is written as a hypothesis, not a finding.** If the row is unverified, the
  paragraph explaining it says "appears to" and not "contradicts".

Everything about Cursor CLI, OpenCode, DeepSeek, GLM, OpenRouter and Vercel is 🔍. That is
the expected state — `plan.md` already says authoring a gateway row "is research, not recall".
This file is the checklist for that research.

**No prices appear**, and no context window for an unverified model. Both are required fields
so that a missing one is a failure rather than a silent default; both use a sentinel a test
rejects. See [Pricing](#pricing).

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

*(Note for anyone tempted by the obvious extra argument: "there is no schema validator in the
tree" would be false — `zod` and `ajv` both arrive transitively, via the MCP SDK, Fastify and
ESLint.)*

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
  /** Styles this model is usable under, at this service, under this mode (req 6).
   *  INVARIANT: every entry must also be a key of the owning mode's `endpoints`. The types
   *  cannot express that — `styles` and `endpoints` are independent — so a catalogue test
   *  enforces it. Without it a row type-checks, joins, and appears in the picker, and then
   *  cannot be spawned because there is nowhere to send the request: a ShipIt-imposed
   *  failure of exactly the kind reqs 1 and 6 exist to prevent. */
  styles: ApiStyle[];
  /** ALWAYS the service's API rate. See Pricing — never the incremental cost. */
  price: ModelPrice;
  /** The window is not intrinsic to the model: today's table records Codex's *effective*
   *  272K rather than the model's advertised maximum, precisely because the harness imposes
   *  and reports it (`model-windows.ts:47` ✅). `default` is required so a missing value is
   *  a failure, not an empty object; `byHarness` carries the case above. Keyed by harness
   *  and not by style, because two harnesses can share a style and still impose different
   *  windows — which an earlier draft got wrong. */
  contextWindow: { default: number; byHarness?: Partial<Record<HarnessId, number>> };
}

interface ModeCommon {
  endpoints: Partial<Record<ApiStyle, string>>;
  models: ModelDef[];
  retired: RetiredModel[];
}

/** `kind` is the ONLY discriminator. An earlier shape carried it twice — once here and
 *  once inside the credential — which let a row say `sub` on one field and `key` on the
 *  other, and attribution, quota and failover would then disagree about whether a turn
 *  was metered (reqs 5, 11, 12). */
export type BillingModeDef =
  | (ModeCommon & { kind: "key"; credential: KeyCredential })
  | (ModeCommon & { kind: "sub"; integration: SubIntegrationId });

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

Credential delivery is not a harness property, and both shipped harnesses show why — each
authenticates *differently depending on the billing mode*:

- **Claude** — a subscription account uses credential files under a scoped `HOME`, and
  `scrubEnvAuthForScopedHome` **deletes** `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from
  the child environment precisely so the CLI reads those files (`claude/process.ts:12` ✅).
  The env vars are the *reserved-route* path, not the general one.
- **Codex** — a subscription uses `~/.codex/auth.json` and the adapter deletes
  `OPENAI_API_KEY`; key mode uses that variable (`codex/adapter.ts:259` ✅).

So it is a function of `(harness, billing mode)` — and **it takes both sides to describe
it**, which is the half that is easy to miss. The service knows *which secret the user supplied*; only the harness knows
*where that secret has to land* for its CLI to read it. One DeepSeek key must appear in
whatever variable Claude Code reads when Claude Code runs it, and in `OPENAI_API_KEY` when
Codex does. Neither declaration alone can say that, so both exist:

```ts
export type CredentialTarget =
  | { kind: "env"; name: string }
  | { kind: "config-file"; path: string; pointer: string };   // OpenCode-shaped

/** SERVICE side, subscription modes: WHICH integration obtains and refreshes the account.
 *  A `sub` mode cannot be described by `kind: "sub"` alone — today's subscriptions are
 *  provider-specific all the way down (an `AgentAuthManager` implementation, a credential-root
 *  layout, a login method, a quota integration in the limits registry), and those are
 *  currently selected by `AgentId`. This field is what they get selected by instead, and it is
 *  the catalogue-side half of the per-service work req 5 keeps out of the mechanism.
 *  🔍 THROUGHOUT — these identifiers do not exist. Today the auth managers and limits
 *  providers are keyed by `AgentId` ("claude", "codex") in a `Map<AgentId, AgentAuthManager>`
 *  (`agents/index.ts:39`, `agent-auth-manager.ts:1`). The OAuth *implementations* are real;
 *  these names are this document's proposal for what replaces `AgentId` as their key. An
 *  earlier version of this block marked them ✅ on the strength of the implementations
 *  existing, which is the inference-as-verified-fact the rules above forbid. */
export type SubIntegrationId = "anthropic-oauth" | "openai-chatgpt" | "zai-plan";

/** SERVICE side, key modes only: what the user supplies and how ShipIt stores it. */
export interface KeyCredential {
  storageEnv: string;
  /** Rare, and the reason the target is not purely a harness property: a service may need
   *  its key in a DIFFERENT variable than the harness's own vendor uses. See below. */
  targetOverride?: Partial<Record<HarnessId, CredentialTarget>>;
}

/** HARNESS side: where a credential of each kind lands for THIS CLI, by default. */
export interface CredentialTargets {
  /** Absent ⇒ this harness cannot carry a raw key at all (an OAuth-only CLI). Such a
   *  harness joins only to subscription modes, narrowing the join rather than failing at
   *  spawn — which is the survey's "a raw API key can authenticate it" row, expressed. */
  key?: CredentialTarget;
  sub: { kind: "scoped-home" } | CredentialTarget;
}
```

**Claude Code's key target is `ANTHROPIC_API_KEY`, not `ANTHROPIC_AUTH_TOKEN`** — the repo
distinguishes them as two different reserved routes, `claude-api-key` and `claude-env-oauth`
(`provider-account-manager.ts:619` ✅), and `setApiKey()` writes the former
(`services/settings.ts:367` ✅). An earlier draft marked `ANTHROPIC_AUTH_TOKEN` ✅ as *the*
key target on the strength of a citation that only proved both variables get scrubbed for a
scoped home — a citation that proved deletion, not destination.

That distinction is also why `targetOverride` exists rather than a bare per-harness map. The
two variables are not interchangeable at the wire: one is an `x-api-key` header and the other
a bearer token, so **which one an Anthropic-*compatible* third-party endpoint wants is a fact
about that service, not about Claude Code** (🔍 per service — a phase-3 checklist item). Most
services need no override; the field exists so the one that does is a row edit rather than a
special case in spawn code.

**`storageEnv` names a slot ShipIt must persist into, which for Anthropic it does not do
today**: `setApiKey()` assigns `process.env.ANTHROPIC_API_KEY` and writes nothing
(`services/settings.ts:367` ✅), where Codex's key *is* persisted in `CredentialData.agentEnv`.
So the variable name is ✅ and the storage is 🔍 — work phase 2 does, not a fact about today.

A key mode's `credential` is a `KeyCredential`; `HarnessDef.spawn.credential` is a
`CredentialTargets`. Resolving a turn reads the source for the value and the target for the
destination — which is exactly the mapping `plan.md`'s "set the credential after the scrub"
was leaving to the implementer.

Two consequences worth stating because they are easy to get wrong in code:

- **The scrub still runs first.** `scrubEnvAuthForScopedHome` deletes the harness's auth
  variables for a scoped account (`claude/process.ts:12` ✅); writing a custom service's key
  into the harness's variable must happen *after* that, or the scrub removes it.
- **The target is the harness's variable, not the service's** — and the storage name must be
  *removed* on the way, which is work rather than a property. Pushed secrets land in the
  worker's own `process.env` (`session-worker.ts:356` ✅) and both adapters copy the whole
  environment into the child (`claude/process.ts:409`, `codex/adapter.ts:243` ✅), so
  `DEEPSEEK_API_KEY` **is** visible to the CLI unless spawn shaping deletes it. It does no harm
  there, but the reverse mistake does: assuming the CLI will read it. Confusing storage with
  target produces a CLI that ignores a key that is demonstrably present, which reads as an auth
  bug and is not.

### When the overlap has more than one style, the harness's order decides

Making `styles` a set on both sides creates a case the scalar version could not have: a
harness and a model can share **two** styles, and every downstream question — which endpoint,
which credential target, which retirement successor, what the resident process was spawned
as — needs exactly one answer.

The rule: **the resolved style is the first entry of the harness's `styles` that the model
also declares.** The harness's array is therefore ordered by preference, not incidentally,
and that ordering is a catalogue decision like any other.

It is deliberately *not* part of `ModelSelection`. The user picks a service, a mode and a
model (req 5); which wire format carries it is ShipIt's business, and putting a fourth
element in the selection would make the persisted identity depend on a catalogue detail that
can be re-ordered later. So the style is **resolved**, and it belongs to the spawn identity
that `plan.md` already respawns on — alongside the endpoint and the credential route.

Neither shipped harness exercises this: both declare exactly one style, so the rule is a
no-op today and the first entry is the only entry. It exists because a multi-style harness
appears to be arriving, and because the alternative — discovering the ambiguity in phase 3
with an implementer picking arbitrarily — is how a silent per-turn inconsistency gets built.

### How a harness is spawned

```ts
export type SpawnShape = {
  /** Where a credential of each kind must land for this CLI. See "Credentials" above. */
  credential: CredentialTargets;
  /** How the model id reaches the process. The two shipped harnesses differ. */
  model:
    | { kind: "flag"; flag: string }                 // Claude: --model <id>
    | { kind: "turn-payload"; field: string };       // Codex: JSON-RPC turn/start
  /** How the endpoint is overridden. `none` means the harness offers no way. */
  endpoint:
    | { kind: "env"; name: string }                         // Claude: ANTHROPIC_BASE_URL
    | { kind: "config"; key: string }                       // Codex: -c <key>=<url>
    | { kind: "config-file"; path: string; pointer: string } // OpenCode: a written file
    | { kind: "none" };                                     // no override offered
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

**There is no model-switching capability flag, and req 4's "as far as that harness supports
it" is currently carried by nothing.** Both shipped harnesses support it — the model is
per-turn data for each — so no flag is declared rather than one being declared `true` twice.
If a survey candidate turns out to fix its model at process start, that is when
`AgentCapabilities` gains the flag and the picker gates on it; inventing it now would be a
field with one possible value.

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
adding a table. **`contextWindow` is therefore required**: dropping it would regress today's
first-frame windows (Claude 1M, Codex 272K), and a bare scalar would lose the harness
dimension the existing table's own comment depends on.

## Harnesses

### The survey

`plan.md` lists six assumptions a third harness could break. **Every Cursor and OpenCode cell
below is 🔍** — this is the state of the survey before phase 1 runs it, not its result.

| | Claude Code | Codex | Cursor CLI 🔍 | OpenCode 🔍 |
|---|---|---|---|---|
| Binary | `claude` ✅ | `codex` ✅ | `cursor-agent` | `opencode` |
| API styles it speaks to a remote endpoint | `anthropic-messages` 🔍 | `openai-responses` 🔍 | unclear — see below | many, incl. `openai-chat-completions` |
| Model per invocation | `--model` flag ✅ | JSON-RPC `turn/start` payload ✅ (`:787`) | `-m/--model <id>` | `-m provider/model` |
| Endpoint overridable | **no seam today** ✅ | **no seam today** ✅ | apparently not | config file only |
| Subscription auth | scoped-home files ✅ | `~/.codex/auth.json` ✅ | n/a | n/a |
| Key auth | `ANTHROPIC_API_KEY` ✅ | `OPENAI_API_KEY` ✅ | `CURSOR_API_KEY`, Cursor's own | per provider, in config |
| Reasoning control | `--effort` enum ✅ | `-c model_reasoning_effort=` ✅ | unknown | `reasoningEffort` in config |
| Dollar telemetry | cumulative `total_cost_usd` per result ✅ | **none — stored as zero** ✅ | unknown | unknown |

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
- **Neither harness reports a per-turn cost.** Claude Code's `total_cost_usd` is the running
  total for the *whole resumed conversation*, not the turn — `UsageManager` derives a per-turn
  figure and keeps the raw cumulative to diff against (`usage.ts:144` ✅). The derivation is
  piecewise, not a clamped subtraction: `current − previous` when a prior cumulative exists
  and has not gone backwards, otherwise **`current` itself**, which covers both the first turn
  of a chain and a reset. (The comment above that code states the clamped form; the code does
  not implement it. Cited to the implementation.) An earlier draft's survey cell said "per-turn cost reported", which is
  the over-broad ✅ this document's own rules forbid. Codex reports nothing at all: turns
  without dollar telemetry are stored at zero,
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
      credential: { key: { kind: "env", name: "ANTHROPIC_API_KEY" },     // ✅ pam.ts:619
                    sub: { kind: "scoped-home" } },                      // ✅ process.ts:12
      model: { kind: "flag", flag: "--model" },             // ✅ claude/process.ts:369
      endpoint: { kind: "env", name: "ANTHROPIC_BASE_URL" }, // 🔍 no seam today
    },
    capabilities: { /* today's AGENT_DEFS entry, minus `models` */ },
  },
  {
    id: "codex",
    name: "Codex",
    binary: "codex",                                        // ✅ agent-registry.ts:191
    styles: ["openai-responses"],                           // 🔍 see the survey note
    spawn: {
      credential: { key: { kind: "env", name: "OPENAI_API_KEY" },        // ✅ adapter.ts:259
                    sub: { kind: "scoped-home" } },                      // ✅ ~/.codex/auth.json
      model: { kind: "turn-payload", field: "model" },      // ✅ codex-event-handler.ts:787
      endpoint: { kind: "config", key: "model_provider.base_url" }, // 🔍 no seam today
    },
    capabilities: { /* today's AGENT_DEFS entry, minus `models` */ },
  },
] as const satisfies readonly HarnessDef[];
```

### Survey candidates — not shipped, not integrated

Cursor CLI and OpenCode appear in the survey table above and **nowhere in the declarations**.
They are not harnesses ShipIt runs, they have no honest `capabilities` to declare, and req 14
governs what an install actually has.

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

**Endpoints and per-model `styles` below are 🔍 throughout**, including on the two
first-party rows. They look like structure and are not: `styles` decides the whole join and
the endpoint decides where a turn is sent, and neither can be established from this
repository — the same reason the harness style rows are 🔍. They are written unmarked inline
only to keep the declarations readable; this paragraph is the marker.

```ts
const A_MSG = "anthropic-messages", O_RESP = "openai-responses", O_CC = "openai-chat-completions";

export const SERVICES = [
  {
    id: "anthropic",
    name: "Anthropic",
    modes: [
      { kind: "sub",                                       // ✅ OAuth accounts exist today
        endpoints: { [A_MSG]: "https://api.anthropic.com" },
        integration: "anthropic-oauth",            // 🔍 NAME — the OAuth flow is ✅, the id is new
        retired: [],
        models: [
          { id: "claude-opus-5",   label: "Opus 5",   styles: [A_MSG], contextWindow: { default: 1_000_000 }, price: PRICE_TODO },
          { id: "claude-sonnet-5", label: "Sonnet 5", styles: [A_MSG], contextWindow: { default: 1_000_000 }, price: PRICE_TODO },
          { id: "haiku",           label: "Haiku 4.5", styles: [A_MSG], contextWindow: { default: 200_000 }, price: PRICE_TODO },
        ] },
      { kind: "key",
        endpoints: { [A_MSG]: "https://api.anthropic.com" },
        credential: { storageEnv: "ANTHROPIC_API_KEY" },    // ✅ name; 🔍 storage
        retired: [],
        models: [
          { id: "claude-opus-5",   label: "Opus 5",   styles: [A_MSG], contextWindow: { default: 1_000_000 }, price: PRICE_TODO },
          { id: "claude-sonnet-5", label: "Sonnet 5", styles: [A_MSG], contextWindow: { default: 1_000_000 }, price: PRICE_TODO },
          { id: "haiku",           label: "Haiku 4.5", styles: [A_MSG], contextWindow: { default: 200_000 }, price: PRICE_TODO },
          { id: "claude-fable-5",  label: "Fable 5",  styles: [A_MSG], contextWindow: { default: 1_000_000 }, price: PRICE_TODO },
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
        integration: "openai-chatgpt",             // 🔍 NAME — auth.json is ✅, the id is new
        retired: [
          // ✅ the id remap `gpt-5.6 → gpt-5.6-sol` is today's normalizeCodexModelId
          // (agent-registry.ts:141). 🔍 the style and the placement under BOTH modes are
          // this document's inference — the shim is mode-blind and style-blind.
          { id: "gpt-5.6", styles: [O_RESP], successors: { [O_RESP]: "gpt-5.6-sol" } },
        ],
        models: [
          { id: "gpt-5.6-sol",   label: "GPT-5.6 Sol",   styles: [O_RESP], contextWindow: { default: 272_000 }, price: PRICE_TODO },
          { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", styles: [O_RESP], contextWindow: { default: 272_000 }, price: PRICE_TODO },
          { id: "gpt-5.6-luna",  label: "GPT-5.6 Luna",  styles: [O_RESP], contextWindow: { default: 272_000 }, price: PRICE_TODO },
          { id: "gpt-5.4",       label: "GPT-5.4",       styles: [O_RESP], contextWindow: { default: 272_000 }, price: PRICE_TODO },
          { id: "gpt-5.4-mini",  label: "GPT-5.4 Mini",  styles: [O_RESP], contextWindow: { default: 272_000 }, price: PRICE_TODO },
          { id: "gpt-5.5",       label: "GPT-5.5",       styles: [O_RESP], contextWindow: { default: 272_000 }, price: PRICE_TODO },
          { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", styles: [O_RESP], contextWindow: { default: 272_000 }, price: PRICE_TODO },
          { id: "gpt-5.2",       label: "GPT-5.2",       styles: [O_RESP], contextWindow: { default: 272_000 }, price: PRICE_TODO },
        ] },                                               // ✅ all eight, in CODEX_MODELS order
      { kind: "key",
        endpoints: { [O_RESP]: "https://api.openai.com", [O_CC]: "https://api.openai.com" },
        credential: { storageEnv: "OPENAI_API_KEY" },       // ✅ codex/adapter.ts:259
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
        credential: { storageEnv: "DEEPSEEK_API_KEY" },
        retired: [],
        models: [
          // Only V4 Flash is believed supported under Codex — the founding example of
          // why req 6 declares models per style rather than deriving them.
          { id: "deepseek-v4-flash", label: "V4 Flash", styles: [O_CC, O_RESP, A_MSG], contextWindow: CONTEXT_TODO, price: PRICE_TODO },
          { id: "deepseek-v4-pro",   label: "V4 Pro",   styles: [O_CC, A_MSG],         contextWindow: CONTEXT_TODO, price: PRICE_TODO },
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

### What the join produces is derived, and not restated here

Which harness reaches which service falls out of the declarations, it depends on API-style
rows that are 🔍 for **every** harness, and a test over the real rows will assert it without
drifting. Two attempts to enumerate the pairings in prose have failed here: the first went
stale within a day, and its replacement asserted a categorical claim
("`openai-chat-completions` has no harness at all") derived with confidence from rows this
same document marks unverified.

## Pricing

Req 16 reports what was spent per service and billing mode, and what subscription usage
**would have cost at that service's API rates**. Neither number can come from the harness:
`total_cost_usd` is the CLI's own price table applied to whatever model *it* thinks it is
running — measured, in `plan.md`, as a constant 18× on real turns — and Codex reports no
dollar figure at all.

```ts
export interface ModelPrice {
  input: number;        // USD per million input tokens
  output: number;
  /** Required, because ShipIt already records these token classes separately
   *  (`usage.ts:45` ✅) and an absent rate would silently price them at zero — the
   *  cache-heavy turn is exactly where that is most wrong. A service with no separate
   *  cache pricing sets these equal to `input`; `cacheWrite` is ShipIt's `cache_create`. */
  cacheRead: number;
  cacheWrite: number;
}

/** Sentinels for values that have not been checked. Phase 1 replaces every one; a catalogue
 *  test asserts no shipped row still carries either. Negative rather than zero so a forgotten
 *  row is loud — zero is a value that reads as an answer. */
export const PRICE_TODO: ModelPrice = { input: -1, output: -1, cacheRead: -1, cacheWrite: -1 };
export const CONTEXT_TODO = { default: -1 };
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
