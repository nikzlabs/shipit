---
issue: planning#321
title: Custom models — harness and service catalogue
description: Harnesses and services as the TypeScript declarations phase 1 will carry — types settled, first-party rows complete, everything else a marked research checklist.
---

# 252 — Harness and service catalogue

The inventory of what ShipIt will run: every **harness** (agent CLI) and every **service**
(a credentialed source of models), in the form they take in the source tree. Companion to
[`plan.md`](./plan.md); the requirements they serve are in
[`requirements.md`](./requirements.md), chiefly req 15 (what the launch catalogue contains),
req 6 (how a model becomes available on a harness), req 13 (retirement) and req 16 (cost).

What these rows do when actually run is measured in
[`pair-verification.md`](./pair-verification.md) — a live turn per viable
`(harness, service, billing mode, model)` pair.

This document settles **the types, and the rows that this repository can settle** — the
Anthropic and OpenAI inventories are written out in full, because phase 1's review criterion
is that the picker offers exactly what it offers today.

It is not a finished catalogue and does not claim to be. The 🔍 rows are research first: GLM,
OpenRouter and Vercel are named with their contents deliberately open, since req 6's
maintained subset is a judgement made when a row is authored.

**Two shape questions stay open on purpose**, both raised by the survey and neither affecting
a shipped harness: how a harness fused to its own service (Cursor) would be represented, and
how a `serviceId` becomes a provider namespace for a CLI taking `provider/model` (OpenCode).
`SpawnShape.model` expresses neither rather than guessing. A third is closed — `SpawnShape`
carries the config-file case for endpoint and credential, and `CredentialTargets` is optional
on both sides, so an OAuth-only or key-only CLI narrows the join instead of failing at spawn.

### Why the Cursor CLI / OpenCode survey is in this document

Stated at length because it is the thing a reviewer most often proposes cutting, on the
reasonable-sounding ground that no numbered requirement commits to either harness.

That is true, and it is not the point. **Phase 1 freezes the types every later phase is built
on**, and the cheapest moment to learn that a harness violates one of them is before that
happens. The survey has already paid for itself twice: it is why `HarnessDef.styles` is a set
rather than a scalar — because a multi-provider CLI appears to speak several — and why
`SpawnShape` carries a config-file variant at all. Both were one-field changes at this stage.
Discovering either after phase 6 would mean re-cutting the catalogue, the picker and the usage
grouping.

Two boundaries keep it from becoming scope creep. Nothing here proposes *shipping* Cursor or
OpenCode — req 14's install-time selection already covers how a harness arrives — and neither
appears in the `HARNESSES` declaration, only in the survey table. The one shape question the
survey leaves open (how a service-fused harness would be represented) is deliberately
unanswered rather than speculatively designed.

Its *consequences* for the design live in `plan.md`'s
[What a third harness could break](./plan.md#what-a-third-harness-could-break); the rows live
here.

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
   *  failure of exactly the kind reqs 1 and 6 exist to prevent.
   *  Three more the same test covers, because these are plain arrays and the selection
   *  triple assumes otherwise: **at most one mode per `kind` per service**, **no duplicate
   *  model id within a mode**, and **at least one entry in `credentials`**. The first two
   *  would make one `ModelSelection` match two rows with no tie-break; the third would
   *  declare a mode nothing can authenticate. */
  styles: ApiStyle[];
  /** ALWAYS the service's API rate. See Pricing — never the incremental cost. */
  price: ModelPrice;
  /** ✅ what the repo shows: the table stores `272_000` for the GPT-5 family
   *  (`model-windows.ts:47`), and runtime telemetry replaces it with whatever the app-server
   *  reports (`codex-event-handler.ts:625`).
   *  🔍 everything else, including both halves of the usual rationale: that this differs from
   *  the model's advertised maximum, and that Codex is the cause. Both appear in that file as
   *  a comment, not as anything the code demonstrates.
   *  So why key by harness at all? Because the value ShipIt reports is per-harness telemetry
   *  by construction — it comes from the app-server that ran the turn — and a scalar could
   *  not hold two harnesses' answers for one model. That argument needs neither 🔍 claim. `default` is required so a missing value is
   *  a failure, not an empty object; `byHarness` carries the case above. Keyed by harness
   *  and not by style, because two harnesses can share a style and still impose different
   *  windows — which an earlier draft got wrong. */
  contextWindow: { default: number; byHarness?: Partial<Record<HarnessId, number>> };
}

interface ModeCommon {
  endpoints: Partial<Record<ApiStyle, string>>;
  models: ModelDef[];
  retired: RetiredModel[];
  /** The credential shapes this mode ACCEPTS — not the user's credentials themselves. A list
   *  because one mode can accept several shapes: Anthropic's subscription takes both OAuth
   *  accounts and an env-supplied token. The user's actual credentials are *instances* of
   *  these shapes, and live in storage with their own route ids — see below. */
  credentials: ModeCredential[];
}

/** `kind` is the sole billing discriminator, and `quota` is required exactly where a quota
 *  exists — encoded in the union rather than as an optional field, so "a subscription with
 *  nowhere to read its quota from" (req 10) cannot be declared. */
export type BillingModeDef =
  | (ModeCommon & { kind: "key" })
  | (ModeCommon & { kind: "sub"; quota: QuotaIntegrationId });

/** These are NOT the same axis, and collapsing them is the mistake this shape exists to
 *  prevent: a **subscription** can be delivered as a **string in an environment variable**,
 *  with no login flow and no account root. This repository already contains one —
 *  `claude-env-oauth`, which is quota-bearing (`provider-account-reserved-route.test.ts:92`,
 *  `claude/limits-provider.ts:85` ✅) and ranked above the metered API-key route
 *  (`provider-account-manager.ts:619` ✅). Three citations because it is three claims.
 *
 *  Precision matters here: that token is an **OAuth token**, NOT an API key —
 *  `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` are deliberately distinct routes at the
 *  same citation, and an earlier version of this comment called it a key. What the two have
 *  in common is only the delivery shape, which is exactly the axis `via` names. */
/** `via` is about DELIVERY — what ShipIt holds and how it reaches the CLI. Never billing. */
export type ModeCredential =
  | { via: "account"; login: LoginIntegrationId }   // a login flow producing an account root
  | { via: "string"; storageEnv: string;            // a secret: pasted, or supplied by env
      targetOverride?: Partial<Record<HarnessId, CredentialTarget>>;
      /** The harnesses that can actually authenticate with this credential —
       *  absent means "any harness with a string target". Added by docs/268
       *  phase 10 (`types.ts:243` ✅): a string-delivered credential is not
       *  always a neutral API key (`claude-env-oauth` is an Anthropic OAuth
       *  token only Claude Code can carry; GLM's plan key is `carriers:
       *  ["claude"]`), and with a second anthropic-messages harness the style
       *  join alone would offer such credentials on harnesses whose every
       *  turn 401s. */
      carriers?: HarnessId[] };

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

- **Claude** — a subscription account uses credential files under a scoped `HOME`, and in
  **local mode** `scrubEnvAuthForScopedHome` deletes `ANTHROPIC_API_KEY` and
  `ANTHROPIC_AUTH_TOKEN` from the child environment so the CLI reads those files
  (`claude/process.ts:28` ✅). **That scrub is local mode only** — it returns immediately
  without a `scopedHome`, and the container worker constructs `ClaudeProcess` with no resolver
  (`session-worker.ts:752` ✅); in container mode the account's credentials arrive by mount
  instead. `plan.md`'s Appendix A records the same asymmetry. What is *not* general is the account
  root: `claude-env-oauth` is a subscription that authenticates from the environment and has
  no account root at all (`local-agent-home.ts:84` ✅) — which is the whole reason `via`
  exists. An earlier version of this sentence claimed the opposite, contradicting the type
  it appears above.
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
/** Selects the login/refresh implementation. Only `via: "account"` modes need one. */
export type LoginIntegrationId = "anthropic-oauth" | "openai-chatgpt";

/** Selects the quota-reporting implementation — what fills req 10's indicator. Keyed
 *  separately from the login flow because the two do not always come together. */
export type QuotaIntegrationId = "anthropic-oauth-usage" | "openai-chatgpt-usage" | "zai-plan-usage";
```

Since docs/272 the union also carries `"opencode-go-usage"`, and it is the case that shows
"declared" and "implemented" are genuinely separate: OpenCode publishes no per-key usage API
at all, so Go's integration ships with **no reader by decision** rather than by backlog — the
mode reports nothing and ShipIt reacts to the service's own 429 instead.

**GLM is the case that forces this, and it is the launch subscription** (req 15): its coding
plan is billed as a *plan* — an allowance, not per-token — while being authenticated with an
ordinary API key, which for Claude Code goes in `ANTHROPIC_AUTH_TOKEN` rather than
`ANTHROPIC_API_KEY` (🔍, to confirm when the row is authored). Under a shape where `sub` meant
"an account obtained by a login flow", the one custom subscription this feature commits to
shipping could not be declared at all.

```ts
// GLM's coding plan: kind "sub" (an allowance), via "string" (a secret in a variable),
// and a quota to report despite having no login flow.
{ kind: "sub", quota: "zai-plan-usage",
  credentials: [{ via: "string", storageEnv: "ZAI_CODING_PLAN_KEY",
                  targetOverride: { claude: { kind: "env",
                                              name: "ANTHROPIC_AUTH_TOKEN" } } }],
  … }
```

So there are **three independent axes**, and each has exactly one owner:

| Axis | Field | Answers |
|---|---|---|
| How you pay | `kind` | fail over? (req 12) show a quota? (req 10) money or allowance? (req 16) |
| How you authenticate | `credentials[].via` | where the secret comes from, where it lands |
| Where quota comes from | `quota` | what fills req 10's indicator |

No code path should read `via` to answer a billing question, and none should read `kind` to
decide how to authenticate. Tying quota to `via` was an earlier mistake that left GLM's plan —
a subscription with no login flow — unable to report a quota at all.

### A string-delivered subscription needs many credential instances, not one env slot

This is the one place the design needs storage that does not exist, and it follows directly
from req 12. A `via: "account"` mode already supports several credentials — that is what
`ProviderAccount` rows are, and failing over between them is the behaviour req 12 preserves. A
`via: "string"` mode has no equivalent: today a supplied secret goes into a single named slot
and writing it overwrites the previous value (`credential-store.ts:298` ✅).

For a **key** mode that is fine — req 12 says keys do not fail over, so one is all it can use.
For a **subscription** mode delivered as a string it is not: GLM's coding plan is exactly that
shape, and a user with two of them is precisely the case req 12 exists for.

So `storageEnv` is **the variable a credential is materialized into at spawn** and never the
place it is stored. Storage is per *instance*, the way accounts already are:

```ts
/** ONE type for every credential the user holds, replacing `ProviderAccount` rather than
 *  sitting beside it. An earlier draft declared a `via: "string"` twin, which left two
 *  questions unanswered — what `ProviderAccount` is re-keyed *to*, and which routing state the
 *  new type needs — and the answer to both is that there is only one type.
 *
 *  Two things change from `ProviderAccount` (`domain-types/provider.ts:16` ✅):
 *   - keyed by `(serviceId, billingMode)` instead of `provider: AgentId`, which is the
 *     conflation this whole feature removes;
 *   - `via` distinguishes a login-flow account from a supplied secret, so plural
 *     string-delivered subscriptions (GLM's plan) become expressible.
 *
 *  **Every other field is preserved, including the ones that look like clutter.** Selection
 *  filters on `status` and `exhaustedUntil` (`provider-account-manager.ts:648` ✅), balanced
 *  routing reads `lastUsedAt` (`:536` ✅), hard exhaustion is persisted precisely so a failed
 *  credential is not chosen again (`:788` ✅), and duplicate detection and label adoption use
 *  `externalId` and `labelIsGenerated` (`:443` ✅). An earlier draft dropped four of them while
 *  claiming to preserve everything; each omission is a silent behaviour change.
 *
 *  **No secret on this record.** A `via: "string"` credential's secret lives in the credential
 *  store keyed by route id, exactly as a `via: "account"` credential's root lives on disk
 *  keyed by account id — symmetric, and it keeps this type safe to return verbatim through
 *  Settings, which is what happens today (`services/settings.ts:384` ✅). Putting an optional
 *  `secret` here would have required a redaction boundary that did not exist, and would have
 *  typed two impossible states: an account with a secret, and a string route without one. */
export interface CredentialRoute {
  id: string;                    // the route id, as today
  serviceId: ServiceId;
  billingMode: BillingMode;
  via: "account" | "string";
  label: string;
  labelIsGenerated?: boolean;    // label adoption
  externalId?: string;           // duplicate-account detection
  isPrimary: boolean;            // derived on read from `priority`, but on the wire shape
  priority: number;              // authoritative order
  status: "ready" | "authenticating" | "auth_failed" | "unavailable";
  capabilities?: ProviderAccountCapabilities;
  lastUsedAt?: number;
  exhaustedUntil?: number | null;
  createdAt: number;
  updatedAt: number;
}
```

`ProviderRouteKind` (`"account" | "reserved"`, `domain-types/provider.ts:3` ✅) gains a third
member for this, because a user-managed plural secret is neither: not `reserved`, which means
env-supplied and singleton, and not `account`, which means a login flow and a credential root.
`provider_route_kind` on a session (`session.ts:205` ✅) then carries it.

**This is the only piece of genuinely new persistence in the design.** It cannot be reached by
re-keying `agentEnv`, which is a single `Record<string, string>` whose named slot the next
write overwrites (`credential-store.ts:34`, `:298` ✅). Phase 2 owns it.

```ts
/** HARNESS side: where a credential of each kind lands for THIS CLI, by default.
 *  Keyed by `via`, NOT by billing `kind` — an earlier version named these `key`/`sub`, which
 *  read as billing and left the mapping to the implementer. */
/** Both optional, and the narrowing runs both ways — an earlier version made `account`
 *  mandatory, which forced a key-only CLI (both survey candidates look like one) to invent a
 *  fake account destination and could make an account-backed service falsely eligible.
 *  INVARIANT: at least one is present, or the harness can authenticate nothing at all.
 *  Eligibility must read this: a mode whose credential shapes this harness cannot carry is
 *  not offered, rather than offered and failing at spawn. */
export interface CredentialTargets {
  string?: CredentialTarget;                          // absent ⇒ OAuth-only CLI
  account?: { kind: "scoped-home" } | CredentialTarget; // absent ⇒ key-only CLI
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

A mode's `credentials` are `ModeCredential`s; `HarnessDef.spawn.credential` is a
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
  // 🔍 NOT SETTLED: the survey records OpenCode taking `-m provider/model`, which neither
  // variant expresses — the flag carries a bare model id, and nothing says how a `serviceId`
  // becomes that CLI's provider namespace or what happens when the two names differ. Left
  // undeclared rather than guessed; it is on the phase-1 checklist.
  /** How the endpoint is overridden. `none` means the harness offers no way. */
  endpoint:
    | { kind: "env"; name: string }                         // Claude: ANTHROPIC_BASE_URL
    | { kind: "config"; key: string }                       // Codex: the base-URL field of a written provider block
    | { kind: "config-file"; path: string; pointer: string } // OpenCode: a written file
    | { kind: "none" };                                     // no override offered
};

export interface HarnessDef {
  id: string;
  name: string;
  binary: string;
  /** The service this CLI's own vendor provides, when there is one. Declared because the
   *  metered-spend column sources from the harness only on this service (see Pricing), and an
   *  undeclared "everyone knows Claude Code means Anthropic" mapping is exactly the
   *  harness/service conflation this feature removes. Absent for a harness whose vendor sells
   *  no models. Note it does NOT decide the rule on its own — billing mode does; this only
   *  narrows where the key-mode figure may come from. */
  nativeService?: ServiceId;
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
| Subscription auth | account root under `HOME` ✅ | `auth.json` under `CODEX_HOME` ✅ | n/a | n/a |
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
    nativeService: "anthropic",
    styles: ["anthropic-messages"],                         // 🔍 see the survey note
    spawn: {
      credential: { string: { kind: "env", name: "ANTHROPIC_API_KEY" },  // ✅ pam.ts:619
                    account: { kind: "scoped-home" } },                  // ✅ account roots
      model: { kind: "flag", flag: "--model" },             // ✅ claude/process.ts:369
      endpoint: { kind: "env", name: "ANTHROPIC_BASE_URL" }, // 🔍 no seam today
    },
    capabilities: { /* today's AGENT_DEFS entry, minus `models` */ },
  },
  {
    id: "codex",
    name: "Codex",
    binary: "codex",                                        // ✅ agent-registry.ts:191
    nativeService: "openai",
    styles: ["openai-responses"],                           // 🔍 see the survey note
    spawn: {
      credential: { string: { kind: "env", name: "OPENAI_API_KEY" },     // ✅ adapter.ts:259
                    account: { kind: "scoped-home" } },                  // ✅ CODEX_HOME
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
        quota: "anthropic-oauth-usage",            // 🔍 the id is new
        credentials: [{ via: "account", login: "anthropic-oauth" },      // ✅ OAuth accounts
                      { via: "string", storageEnv: "ANTHROPIC_AUTH_TOKEN" }], // ✅ env-oauth
        retired: [],
        models: [
          { id: "claude-opus-5",   label: "Opus 5",   styles: [A_MSG], contextWindow: { default: 1_000_000 }, price: PRICE_TODO },
          { id: "claude-sonnet-5", label: "Sonnet 5", styles: [A_MSG], contextWindow: { default: 1_000_000 }, price: PRICE_TODO },
          { id: "haiku",           label: "Haiku 4.5", styles: [A_MSG], contextWindow: { default: 200_000 }, price: PRICE_TODO },
        ] },
      { kind: "key",
        endpoints: { [A_MSG]: "https://api.anthropic.com" },
        credentials: [{ via: "string", storageEnv: "ANTHROPIC_API_KEY" }], // ✅ name; 🔍 storage
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
        quota: "openai-chatgpt-usage",             // 🔍 the id is new
        credentials: [{ via: "account", login: "openai-chatgpt" }],      // ✅ auth.json
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
        credentials: [{ via: "string", storageEnv: "OPENAI_API_KEY" }],  // ✅ adapter.ts:259
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
        endpoints: { [O_CC]: "https://api.deepseek.com",
                     // ✅ 2026-08-13 — Codex appends `/responses` to a provider's base
                     // URL, so the Responses base carries the `/v1`.
                     [O_RESP]: "https://api.deepseek.com/v1",
                     [A_MSG]: "https://api.deepseek.com/anthropic" },
        credentials: [{ via: "string", storageEnv: "DEEPSEEK_API_KEY" }],
        retired: [],
        models: [
          // ✅ 2026-08-13 — DeepSeek serves the Responses API NATIVELY (no proxy),
          // specifically to support Codex: `deepseek-v4-flash` from 2026-07-31,
          // `deepseek-v4-pro` (V4-Pro-0813) from 2026-08-13. Both verified through
          // codex-cli 0.146.0 against the real endpoint, including the `apply_patch`
          // tool loop. The founding example of why req 6 declares models per style
          // rather than deriving them.
          { id: "deepseek-v4-flash", label: "V4 Flash", styles: [O_CC, O_RESP, A_MSG], contextWindow: CONTEXT_TODO, price: PRICE_TODO },
          { id: "deepseek-v4-pro",   label: "V4 Pro",   styles: [O_CC, O_RESP, A_MSG], contextWindow: CONTEXT_TODO, price: PRICE_TODO },
        ] },
    ],
  },
  {
    id: "zai", name: "GLM (Z.ai)",                         // 🔍 ENTIRE ROW
    modes: [
      { kind: "sub",  // an allowance, authenticated by a key — see ModeCredential above
        quota: "zai-plan-usage",  // a plan HAS a quota even with no login flow (req 10)
        credentials: [{ via: "string", storageEnv: "ZAI_CODING_PLAN_KEY",
                        targetOverride: { claude: { kind: "env",
                                                    name: "ANTHROPIC_AUTH_TOKEN" } } }],
        /* 🔍 endpoints, models, quota — phase 2 owns this integration */ },
      { kind: "key", credentials: [{ via: "string", storageEnv: "ZAI_API_KEY" }],
        /* 🔍 offers more models than the plan — that asymmetry is the point */ },
    ],
  },
  // 🔍 Both gateways: one `key` mode each, shape identical to DeepSeek's above. Endpoints,
  // styles and the maintained subset (req 6) are authored per gateway against its current
  // documentation — deliberately not guessed here, so these rows are elided rather than
  // filled with plausible-looking values.
  { id: "openrouter", name: "OpenRouter",
    modes: [{ kind: "key", credentials: [{ via: "string", storageEnv: "OPENROUTER_API_KEY" }],
              endpoints: { /* 🔍 */ }, models: [ /* 🔍 */ ], retired: [] }] },
  { id: "vercel", name: "Vercel AI Gateway",
    modes: [{ kind: "key", credentials: [{ via: "string", storageEnv: "VERCEL_AI_GATEWAY_API_KEY" }],
              endpoints: { /* 🔍 */ }, models: [ /* 🔍 */ ], retired: [] }] },
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
**would have cost at that service's API rates**. For a **redirected** turn — any custom
service — neither number can come from the harness: `total_cost_usd` is the CLI's own price
figure whose provenance this repository does not establish — the adapter copies the raw field
through (`claude/adapter.ts:318` ✅) and nothing shows which price table produced it. `plan.md`
records what the dogfood data does and does not show; two attempts to state a ratio were
withdrawn, and the design needs neither. For a turn on the harness's **own** vendor, ShipIt bills against it today — the adapter
copies `total_cost_usd` through (`claude/adapter.ts:318` ✅) and `UsageManager` deltas it
(`usage.ts:115` ✅) — but *what it means* there is 🔍: neither citation shows whose price table
produced it, nor what it represents on a subscription turn where no money moved.

**The rule: the column decides the source, not the turn.** Req 16 asks for two different
figures, and they are different *kinds* of thing. Each has exactly one source:

| Column | Which rows | Source |
|---|---|---|
| **Metered spend** — money that left the account | `billingMode: "key"` only | The harness's own figure when the turn ran on its `nativeService` **and** it reported one; otherwise the persisted rates. |
| **At API rates** — what plan usage would have cost | `billingMode: "sub"` only | **Always** the persisted rates. Never harness telemetry. |

A subscription row contributes **nothing** to metered spend, because no money moved — req 16
says the comparison is "shown as a comparison and never as money spent". A key row has no
"at API rates" figure, because for a key row that *is* the spend.

This replaces an earlier rule of the form "the table everywhere **except** the harness's own
`nativeService`, where the reported figure is preserved". That shape was wrong, and it took
five review rounds each restating the exception more precisely to see why: the exception was
keyed on the wrong axis. Keyed on **service**, it reaches all four (native × mode) cells; only
one of them is a record of real money. The three it should never have touched:

- **Native + subscription** (Claude on an Anthropic plan). The preserved figure describes a
  turn where nothing was billed. It cannot be metered spend, and it cannot be the "at API
  rates" comparison either, because nothing establishes it *is* an API-rate valuation. Under
  the old rule this cell had no honest reading, which is why "what a first-party
  `total_cost_usd` means on a subscription turn" kept being deferred to phase 6 as a narrow
  open question. It was not narrow — it was the exception being wrong.
- **Native + key, harness reports nothing.** Codex declares `nativeService: "openai"` and emits
  no cost at all (`codex-event-handler.ts:611` ✅, stored as zero at
  `ws-handlers/agent-listeners.ts:1198` ✅). A service-only exception preserved `$0` for every
  metered OpenAI turn — real spend reported as free, in the one column req 16 exists to make
  honest. The previous round patched this by bolting "*and* the harness actually reported a
  figure" onto the exception; the fix was correct and the shape still wasn't.
- **Redirected turns**, which the old rule already excluded, but only as a third clause rather
  than as a consequence of anything.

Keyed on **billing mode**, the exception lands on exactly one cell — native + key + a figure
present — and that is precisely the cell the existing accuracy claim covers: `UsageManager`
calls its delta "the true session bill" (`usage.ts:115` ✅) and docs/013 describes
post-migration turns as exact. The preamble to `requirements.md` makes that existing behaviour
contractual, so the design is not entitled to replace a genuinely-billed first-party number
with a four-rate approximation — and now it doesn't have to, without contaminating the other
three cells to do it. (An earlier version argued the opposite way, for uniformity, on the
grounds that the column "was already an estimate". That is unsupported and was reasoning
backwards from a preference for one rule.)

Billing mode is the right axis because it is already the axis that owns money-vs-allowance —
req 16 splits on it, and this document's three-axes section gives it that job. The rule stops
being "a general rule with an exception" and becomes "each column has one source", which is
also what makes the aggregation unambiguous: **"at API rates" always recomputes from the
persisted rates; "metered spend" sums the stored per-turn figure.** `plan.md` phase 6 states
that as the aggregation contract.

**One consequence is user-visible and is not a free win.** Today a Claude subscription session
shows a dollar figure in the context dial and the usage modal (`ContextDial.tsx:216` ✅,
`UsageModal.tsx:315` ✅). Under this rule that figure is not metered spend, so those surfaces
change for existing subscription users. Req 16 decides the *reporting* half — plan usage is
"never money spent" — but not what the dial should show instead. That is an open question in
`requirements.md`, not something this document settles.

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

**A rate is only meaningful against a token count that means the same thing, and the two
harnesses did not agree.** Claude's `input_tokens` *excludes* cache: the adapter computes
occupancy as `input + cache_read + cache_create` (`claude/adapter.ts:292` ✅), which is only
correct if the three are disjoint. Codex reports `inputTokens` and `cachedInputTokens` as
sibling fields (`codex-rate-limits.ts:20` ✅), and phase 3 **measured** what the relationship
between them is rather than leaving it as upstream semantics nobody had checked: driving
`codex app-server` against a recorder that returned `input_tokens: 1000` with
`cached_tokens: 800`, it reported `inputTokens: 1000` and `cachedInputTokens: 800`. **They
overlap.** Left alone, `input × inputRate + cacheRead × cacheReadRate` charges the cached
tokens twice, at the more expensive rate, on every Codex turn.

That mattered more under the new rule than the old one, because Codex reports no dollar figure
and therefore *always* falls through to the rates. Phase 3 normalizes at the **adapter
boundary** (`codex-event-handler.ts`) — subtracting the cached count from the input one before
the event leaves the harness — so the pricing code can assume disjointness rather than each
reader re-deriving it. Whoever adds a harness owns the same obligation for it.

**A gateway is not a pass-through, and the rows used to assume it was (found 2026-08-16).**
`services.ts` asserted that OpenRouter and Vercel both bill at the upstream vendor's list
rate, and every gateway row therefore reused its upstream's price constant. Both gateways
publish their catalogue with prices at a public unauthenticated endpoint
(`openrouter.ai/api/v1/models`, `ai-gateway.vercel.sh/v1/models`), and they disagree with
the upstream **and with each other**, in both directions:

| Model | Vendor direct | OpenRouter | Vercel |
|---|---|---|---|
| DeepSeek V4 Flash | 0.14 / 0.28 | 0.061 / 0.123 | 0.20 / 0.40 |
| DeepSeek V4 Pro | 0.435 / 0.87 | 1.168 / 2.336 | 1.74 / 3.48 |
| GLM-5.2 | 1.40 / 4.40 | 0.308 / 0.968 | 1.10 / 3.851 |
| GPT-5.6 Terra | 2.00 / 12.00 | 1.00 / 6.00 | 2.00 / 12.00 |

So req 16's estimate was wrong by ~2.3× in one direction and ~2.7× in the other for the same
DeepSeek turn depending only on which gateway carried it. Each gateway now carries its own
constants and shares an upstream one only where the two figures were **compared** and found
equal — the Anthropic line, plus GPT-5.6 Sol. `catalogue.test.ts` pins the correction by
naming the pairs; a generic "every row has a price" check could not see it.

**The four rates are an approximation, and that is a deliberate reading of req 16.** Real
published pricing is richer: Anthropic prices 5-minute and 1-hour cache writes differently and
tiers by context length; OpenRouter publishes per-request, image, web-search and reasoning
dimensions with tiering on top. ShipIt could not use that fidelity anyway — it records a
single `cache_create` figure (`usage.ts:45` ✅), so the extra dimensions have no token counts
to multiply. Modelling each provider's full schema means a pricing engine per service,
maintained against vendors who change it, to refine a number req 16 wants for a *comparison*
and a service-level split. So these figures are labelled estimates and the requirement is read
as written: it asks where money went, not for an invoice.

**That has a consequence for the wording, and it is not optional.** A figure derived from four
rates cannot be labelled "You paid", which asserts a fact about a bank statement. It is
ShipIt's estimate of metered spend and the UI must say so — the prototype's headline needs
changing. Labelling an estimate as the thing it approximates is the same class of dishonesty
as `total_cost_usd`, which is what started this section. If exact billed figures are wanted,
that is a requirements conversation and a different mechanism (reading each vendor's billing
API), not a wider table here.

`plan.md` records the standing risk: per-model pricing widens what a catalogue row costs to
maintain, prices move more often than model lists do, and if the upkeep proves unacceptable
the thing to drop is req 16's cost figures rather than to scatter a second price source.

## What phase 1 must check before authoring

Every 🔍, but these change the *shape* rather than the contents:

1. **What wire format does each harness actually speak to a redirected endpoint?** **Answered
   for the two shipped harnesses in phase 3, by measurement** (CLI 2.1.220, codex-cli 0.146.0,
   against a local HTTP recorder): Claude Code speaks Anthropic Messages at
   `<ANTHROPIC_BASE_URL>/v1/messages`, and Codex speaks the Responses API at
   `<base_url>/responses` — and **only** that, since a provider declaring `wire_api = "chat"`
   is rejected outright. Still 🔍 for the two survey candidates. The Codex answer corrected a
   catalogue row: `model_provider` names a block in `model_providers`, so the seam is a whole
   provider block rather than a `model_provider.base_url` key; see `plan.md`'s phase-3 notes.
2. **Does Cursor CLI support a base-URL override?** If not it is a fused `(harness, service)`
   pair rather than a harness.
3. **Does driving OpenCode mean writing a per-session `opencode.json`?** If so, `SpawnShape`
   needs a config-file writer and per-session config generation is a new spawn-path concern.
   And **how does a `serviceId` map to its provider namespace** in `-m provider/model`? If
   the names can differ, `SpawnShape.model` needs a namespace alongside the id — a field, but
   only if the answer says so.
4. **Is `claude-fable-5` genuinely unavailable under an Anthropic subscription?** Today's
   `METERED_MODELS` asserts metered billing, not exclusion.
5. **Which DeepSeek models serve the Responses API, and do OpenRouter or Vercel speak it?**
   **DeepSeek: answered 2026-08-13** — both `deepseek-v4-flash` and `deepseek-v4-pro` serve
   it natively at `https://api.deepseek.com` (OpenAI SDK path `/v1/responses`), verified
   through codex-cli 0.146.0. **Vercel: confirmed 2026-08-15** — both `openai/gpt-5.6-sol` and
   `openai/gpt-5.6-terra` complete a real `codex exec` turn over
   `https://ai-gateway.vercel.sh/v1`, so its Responses surface is now measured rather than
   merely documented. **OpenRouter: answered 2026-08-15** (planning#391) — it serves Responses
   at `https://openrouter.ai/api/v1`, an authenticated POST returning a genuine
   `"object":"response"` body where a bogus sibling route on the same base 404s, and a real
   `codex exec` turn completed over it with `wire_api = "responses"`, on
   `deepseek/deepseek-v4-flash`. **`deepseek/deepseek-v4-pro` measured separately 2026-08-16**
   — HTTP 200, `"object":"response"`, `"status":"completed"`, output text `PAIR_OK`, same
   bogus-route control — so both ids carrying the style have been seen to work and neither
   rides on the other. The style is declared on the row's **DeepSeek models only**: one model
   answering does not establish that the gateway translates for an upstream serving no
   Responses API of its own — which Anthropic does not, and which **GLM (Z.ai) was measured
   not to** in the 08-15 run: on its OpenAI-compatible base `/api/paas/v4/responses` 404s
   identically to a bogus route while `chat/completions` reaches the billing gate with a 429,
   so declaring only `A_MSG`/`O_CC` there is correct. Adding a further row is a measurement,
   not a deduction. Evidence and controls for the 08-15 sweep:
   [`pair-verification.md`](./pair-verification.md).
6. **What does GLM's coding plan offer, and how does its auth work?** Phase 2 owns the
   integration and req 15 is unmet until it lands.
7. **Do the gateways translate `A_MSG` / `O_RESP` for an upstream that publishes neither?**
   **ANSWERED 2026-08-16 — yes, both do, and in opposite directions.** A 40-pair serial sweep
   with four passing controls ([`pair-verification.md`](./pair-verification.md)) settled every
   cell: OpenRouter's Anthropic skin carries all four new upstreams while its Responses
   surface carries only Kimi K3; Vercel's Responses surface carries everything but Fable 5
   while its Anthropic skin fails only on Gemini 3.7 Flash (a repeatable
   `400 'system messages are only supported at the beginning of the conversation'`).

   **The heuristic this question was framed around was wrong in both directions.** Declaring a
   style only where the upstream publishes it would have denied eight working pairs and
   asserted six broken ones — so "one model answering does not establish translation" (question
   5) holds, but so does its converse: *one upstream lacking an API does not establish that the
   gateway cannot translate it*. Neither direction is deducible; both are measurements.

   Every added model now reaches a default `claude,codex` install through at least one harness.
   The original text of this question, kept as the record of what was open and why:

   > The 2026-08-16 curation pass added the four frontier coding models both gateways serve that ShipIt held no direct
   > credential for — Grok 4.6, Gemini 3.7 Flash, Kimi K3, Qwen3.8 Max — and could declare only
   > `O_CC`, each gateway's own native API, because none of Google, xAI, Moonshot or Alibaba
   > publishes an Anthropic-Messages or Responses surface upstream. Question 5's rule applies
   > unchanged: one model answering does not establish a translation layer.
   >
   > The cost of that is concrete rather than theoretical. `openai-chat-completions` is spoken
   > by **OpenCode alone**, and the default install is `SHIPIT_HARNESSES=claude,codex` — so all
   > four rows reach a default install through no harness at all. Measuring is cheap and is the
   > same shape as the 08-15 sweep: one Claude Code turn per model against
   > `https://openrouter.ai/api` and `https://ai-gateway.vercel.sh`, one `codex exec` per model
   > against each gateway's `/v1`. The blocker is not method but credentials — neither gateway
   > key is present in a session container, so this needs either a key or the dogfood inner
   > instance's already-adopted `openrouter:key` / `vercel:key` routes.
   >
