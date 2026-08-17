---
issue: planning#431
title: OpenCode inference — fact sheet and design assessment
description: Verified facts about OpenCode Zen / Go (endpoints, auth, wire styles, models, billing, quota) and the proposed catalogue shape. Investigation complete — all requirements questions resolved.
---

# OpenCode inference — fact sheet and design assessment

## As built (2026-08-17) — deltas from §6's assessment

The implementation follows §6 with five deliberate deltas, each verifiable in
`src/server/shared/catalogue/`:

- **Carriers are gated, not open.** §6 read the auth-header matrix as "no
  `carriers` restriction is indicated"; req 5 makes cross-harness offering
  conditional on live pair runs, and none has run (they need a real key — §7).
  Both modes ship `carriers: ["opencode"]`; each widening arrives with its
  pair's evidence.
- **No `/responses` rows yet.** The OpenCode harness speaks
  `openai-chat-completions` and `anthropic-messages` only, so with the carrier
  gate above, Zen's GPT-5.6 family and Grok (and Go's Luna/Grok 4.5) would be
  rows nothing can run. They arrive with the Codex pair verification instead
  of shipping dead. Consequently only the styles models actually use have
  endpoints (`A_MSG`+`O_CC` on Zen, `O_CC` on Go).
- **Go's storage name is `OPENCODE_GO_API_KEY`** (§6 said "same key", which is
  true of the *secret*; the catalogue forbids one `storageEnv` across two
  modes — `credentialModeForStorageEnv` — so the pasted key is stored under
  two mode-scoped names, exactly the GLM `ZAI_CODING_PLAN_KEY`/`ZAI_API_KEY`
  precedent). The Settings surfaces were confirmed not to deduplicate: one
  card per `(service, mode)`, so Go never hides behind an existing Zen key.
- **The service row is LAST in `SERVICES`.** Catalogue order decides defaults
  and unbiased bare-id resolution; Zen carries bare Anthropic ids
  (`claude-opus-5`), and a legacy id must keep resolving to Anthropic.
- **`nativeService: "opencode"` needed three consumers re-keyed**, because
  "native service" had quietly meant "login-backed vendor" everywhere it was
  read: `vendorOwnedRecovery` (credential-failure-policy — a Go 429 must take
  the set-aside/benching path, not an OAuth heal that heals nothing), the
  planning#353 native-vendor skip in `session-agent-env` (an unshaped OpenCode
  spawn cannot authenticate — the adapter refuses it — so an
  OpenCode-key-only install must still settle the row), and
  `requireAccountService` in `services/settings.ts` (account verbs stay 400).
  All three now key on `loginIntegrationForService`, with tests.

Pricing/context provenance for the shipped rows: the models.dev registry
*source* (`sst/models.dev@dev`, checked out 2026-08-17) — the session
container's egress allows GitHub but not models.dev itself. Notable figures
copied verbatim: Zen sells Sonnet 5 at the 2/10 introductory rate (ShipIt's
own Anthropic row deliberately carries the durable 3/15), Zen's DeepSeek V4
Pro is 1.74/3.84 against the vendor's 0.435/0.87, and Go prices DeepSeek V4
Flash at 0.22/0.66 against Zen's 0.14/0.28 — three reasons no price constant
is shared with any other service's rows.

This began as the investigation deliverable for
[requirements.md](./requirements.md): what OpenCode's hosted inference *is*,
established empirically, and how it would land in the docs/252 catalogue.
**The catalogue shape is now implemented** (2026-08-17, see §6 for the
as-built deltas and [checklist.md](./checklist.md) for the item-level state);
§7's real-key items remain the open live-verification phase — until they run,
both modes stay `carriers: ["opencode"]` and the issue stays open.

**Verification markers** (docs/252 discipline): ✅ = observed — in this
repository, in the pinned `opencode-ai@1.18.15` binary, at a local HTTP
recorder driven by that binary, or **live against the real endpoints and the
vendor's own docs pages** (egress was opened for this investigation on
2026-08-17; the earlier egress-blocked caveats are resolved for everything
below marked live). 🔍 = stated by a source this investigation could not
exercise (e.g. behavior that needs a real paid key). What still needs a real
key is listed in §7.

## 1. What the service is

Two paid products and a free tier, one vendor (Anomaly, the SST team), one
console (`console.opencode.ai`), one API key:

| Product | Shape | Base URL | Models (live, current) |
|---|---|---|---|
| **OpenCode Zen** | Pay-as-you-go credits (`key`-shaped) | `https://opencode.ai/zen/v1` ✅ | 62, incl. frontier closed (Claude, GPT, Gemini) |
| **OpenCode Go** | $10/month subscription with usage caps (`sub`-shaped) | `https://opencode.ai/zen/go/v1` ✅ | 19, open-weight coding set |
| Free tier | No credential required | same as Zen | ~7 `*-free` models |

- ✅ live (models.dev registry, 2026-08-17): providers `opencode` ("OpenCode
  Zen") and `opencode-go` ("OpenCode Go"), both `env: ["OPENCODE_API_KEY"]`,
  the two base URLs above.
- ✅ vendor docs (`opencode.ai/docs/zen`, `/docs/go`, fetched live 2026-08-17):
  Zen is "an AI gateway" over a curated, benchmarked model list, credit-based,
  sold at cost ("the only markup is to cover our processing fees"; card fees
  4.4% + $0.30 passed through). Go is "$5 for your first month, then
  $10/month" over the open-model list, "designed primarily for international
  users". **Only one member per workspace can subscribe to Go** ✅.
- ✅ vendor docs: Zen **auto-reload** defaults to $20 when the balance runs
  low, the amount is configurable **and auto-reload can be disabled
  entirely**; the console can also set **monthly usage limits per workspace
  and per member**.
- ✅ live: Go caps — "5 hour limit — $12 of usage, Weekly limit — $30 of
  usage, Monthly limit — $60 of usage", dollar-denominated (vendor docs, with
  a per-model estimated-request table). Vendor states a ~6× usage multiplier
  vs list price as Go's value proposition.
- ✅ live: with no credential the free models still answer (see §3); the CLI
  models this by setting the Zen provider's `apiKey` to the literal
  `"public"` and disabling every non-zero-price model (binary logic ✅, and
  `opencode models` output ✅).

## 2. Auth modes

- **API key** (reqs 3–4): the vendor flow for BOTH products is "sign in to
  OpenCode Zen [console], (subscribe to Go,) copy your API key" ✅ vendor
  docs. Supplied to the CLI by paste (`opencode auth login`) or
  `OPENCODE_API_KEY` ✅; stored in `auth.json` at the data root, injectable
  per docs/268 (`OPENCODE_AUTH_CONTENT` ✅ binary). **One key serves both
  products** ✅ — the same env var authenticated recorder-captured requests to
  both `/zen/v1/...` and `/zen/go/v1/...`.
- **Console OAuth** (follow-up under req 4): the CLI has a device-code OAuth
  integration "OpenCode Console account" against
  `https://console.opencode.ai/auth/device/code`, with refresh-token handling
  ✅ (binary); `OPENCODE_CONSOLE_TOKEN` exists ✅. How the OAuth token reaches
  the inference wire is still unestablished (needs a real login). ⚠ Observed:
  with a *stored* credential and no env key, `opencode run` hung making no
  model request while egress to the console was blocked — a stored-credential
  spawn appears to require console reachability. **Follow-up concern only**:
  launch delivers the key by env var, which did not exhibit this; re-check
  during the login integration.
- Go entitlement is account-side (console "enable OpenCode Go" ✅ CLI dialog);
  there is no separate Go key.

## 3. API styles — Zen speaks all three of ShipIt's `ApiStyle`s, per model

**Style is per model, not per service**, and the vendor publishes it: the
docs' Endpoints tables list, per model, its endpoint path and AI SDK package
✅ (e.g. GPT 5.6 Sol → `https://opencode.ai/zen/v1/responses`,
`@ai-sdk/openai`; GLM-5.3 → `.../chat/completions`,
`@ai-sdk/openai-compatible`), matching the per-model `provider.npm` field in
live models.dev ✅ and the recorder captures of the CLI itself ✅:

| Model family (`provider.npm`) | Path | Auth header the server READS (live ✅, §7 matrix) | ShipIt `ApiStyle` |
|---|---|---|---|
| default (`@ai-sdk/openai-compatible`) — GLM, Kimi, DeepSeek, MiniMax, … | `POST <base>/chat/completions` | `Authorization: Bearer` only | `openai-chat-completions` |
| `@ai-sdk/openai` — GPT family, Grok | `POST <base>/responses` | `Authorization: Bearer` only | `openai-responses` |
| `@ai-sdk/anthropic` — Claude family | `POST <base>/messages` | `x-api-key` only (+ `anthropic-version`) | `anthropic-messages` |
| `@ai-sdk/google` — Gemini family | `POST <base>/models/<id>:streamGenerateContent` | (not measured) | none — ShipIt has no Google style |

- ✅ live end-to-end: a real completion on `/zen/v1/chat/completions`
  (`mimo-v2.5-free`, HTTP 200, streamed reasoning + usage payload).
- ✅ live: **no cross-style translation.** Sending an anthropic-shaped or
  responses-shaped body for a chat-completions-upstream model reaches the
  upstream and fails with its 400 ("specify \"prompt\" or \"messages\"") —
  the gateway forwards, it does not translate. Declare each model exactly
  under the style its vendor endpoint row names.
- ✅ live: all routes exist and models are registry-checked server-side — a
  paid model without a key → `AuthError: "Missing API key"`; a bogus model →
  `ModelError: "Model … is not supported"`.
- ✅ live: the free tier needs no credential at all and is rate-limited
  per-caller (HTTP 429 `FreeUsageLimitError`).
- **Cross-harness consequence (req 5)**: each style's accepted header matches
  its native harness's convention — Claude Code sends `x-api-key` from
  `ANTHROPIC_API_KEY` (its string `CredentialTarget` ✅ catalogue), Codex
  sends Bearer from `OPENAI_API_KEY` ✅, so **no `targetOverride` is needed
  anywhere** — and because `/messages` ignores `Authorization: Bearer`, a
  Bearer-delivered credential (`ANTHROPIC_AUTH_TOKEN`-style) can never work
  there. Full paid-turn pair verification still needs a real key (§7).
- Gemini models stay unrepresentable unless a fourth `ApiStyle` is ever
  justified; they are excluded from the maintained subset (resolved
  requirements question).

## 4. Models and pricing (live models.dev + vendor docs, 2026-08-17)

- **Zen (`opencode`)**: 91 registry entries, **62 current** — Claude
  (`claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`, 4.x line, Haiku),
  GPT (`gpt-5.6-sol/-terra/-luna`, 5.4/5.5 incl. `-pro`, codex variants),
  Gemini 3.x, GLM-5.x, DeepSeek V4, Kimi K2.x/K3, Grok 4.5/4.6, Qwen3.x,
  MiniMax, and ~7 free models. Prices carry cache read/write and context-tier
  steps; vendor lists peak/off-peak pricing for DeepSeek ✅.
- **Go (`opencode-go`)**: 25 entries, **19 current** — the vendor's published
  Go list ✅ (Grok 4.5, GLM-5.1/5.2/5.3, GPT 5.6 Luna, Kimi K2.6/K2.7/K3,
  MiMo-V2.5(-Pro), MiniMax M2.7/M3, Qwen3.6/3.7/3.8 lines, DeepSeek V4
  Flash/Pro, Hy3).
- **The pinned CLI's bundled snapshot (2026-08-07) is already stale against
  live** ✅ measured drift in ten days: new models (`glm-5.3`,
  `gemini-3.7-flash`, `grok-4.6`, `muse-spark-1.2`), several families moved
  from `@ai-sdk/anthropic` to chat-completions (Kimi, MiniMax, DeepSeek,
  GLM on both providers), and Go's DeepSeek prices changed (0.14/0.28 →
  0.22/0.66). **Live models.dev (or the vendor endpoint tables) is the
  authoring source, and rows must be re-checked at authoring time**; the
  maintained-subset decision (resolved: frontier coding set) plus
  `RetiredModel` rows will both get real use.
- The CLI namespace is `-m opencode/<model-id>` / `-m opencode-go/<model-id>`
  ✅, but ShipIt's OpenCode adapter never uses the built-in registry — every
  spawn writes its own `shipit` provider block (docs/268), so catalogue rows
  decide what ShipIt runs.

## 5. Billing hazards

- **Scrub coverage already exists** ✅: `HARNESS_CREDENTIAL_VARS.opencode`
  (`shared/spawn-routing.ts:28`) strips `OPENCODE_API_KEY` and
  `OPENCODE_AUTH_CONTENT` (and the well-known provider keys) from OpenCode
  spawns. Claude/Codex rows deliver the key only into each harness's own
  target variable per `CredentialTargets`.
- **A missed scrub on the Zen key spends real money**: auto-reload (default
  $20, ✅ vendor docs) refills the balance automatically. Softened but not
  removed by two console-side controls ✅: auto-reload can be disabled, and
  workspace/member monthly limits can be set — both user-configured, neither
  ShipIt-visible.
- **Go's "Use balance" option converts cap exhaustion into metered spend** ✅
  vendor docs: when enabled, Go falls back to the Zen balance instead of
  blocking. That is precisely the "silent shift onto metered billing" docs/252
  req 12 refuses — but it happens **server-side, invisibly to ShipIt** (no
  error, no signal). The Go row's settings surface should warn about it; noted
  in the requirements open question.
- Every response body carries a top-level **`cost`** field (string USD, `"0"`
  on free) ✅ live — the source of the CLI's `step_finish.part.cost` (docs/268)
  and the docs/252 "harness's own figure on native + key" cell once
  `nativeService: "opencode"` exists.
- Per-turn title-generator side traffic is **vendor-confirmed** ✅: "You may
  notice low-cost models, such as Haiku, Nano, or Flash, in your usage
  history. OpenCode uses these models to generate session titles."

## 6. Proposed catalogue shape (assessment, not implementation)

- One new `ServiceDef` `{ id: "opencode", name: "OpenCode" }` with two modes,
  matching the two products. **The name is "OpenCode", not "OpenCode Zen"**
  (review finding): the service row carries both products, and a picker label
  naming only the PAYG product would mislabel every Go row — the mode labels
  are where "Zen" and "Go" belong. Both modes accept the *same* pasted key
  (§2), which the GLM precedent already supports (one secret, two
  `(service, mode)` rows) — but the row author must confirm the credential
  surfaces don't deduplicate the two modes into one, hiding Go behind an
  existing Zen key:
  - `{ kind: "key" }` — Zen PAYG. `credentials: [{ via: "string", storageEnv:
    "OPENCODE_API_KEY" }]`. Endpoints per style: `A_MSG:
    "https://opencode.ai/zen"` (Claude-style base, per the docs/268 `/v1`
    convention), `O_RESP: "https://opencode.ai/zen/v1"`, `O_CC:
    "https://opencode.ai/zen/v1"`. Free models are ordinary $0 rows of this
    mode (resolved requirements question); the anonymous no-credential tier is
    out of scope.
  - `{ kind: "sub", quota: <new "opencode-go-usage"> }` — OpenCode Go, the
    GLM-coding-plan shape (sub-via-string, same key). Endpoints as above with
    `/zen/go`. Quota: **decided (req 6)** — the planning#339 shape: a new
    `QuotaIntegrationId` (`opencode-go-usage`) whose reader reports nothing
    until a per-key source exists, with generic 429 refusal-memory benching;
    the Go settings surface carries the "Use balance" warning (§5, §8).
- **Per-model `styles` come straight from the vendor's per-model endpoint
  rows** (§3) — the live pass measured that the gateway does not translate
  across styles, so a model is declared under exactly its published style.
  Each mode's string credential needs no `targetOverride` (the header matrix
  matches every harness's default), and no `carriers` restriction is
  indicated: an ordinary API key that works wherever the wire format does is
  the exact "absent means any harness with a string target" case — subject to
  the real-key pair runs in §7.
- `HarnessDef.opencode` gains `nativeService: "opencode"` — the follow-up
  docs/268's catalogue row deferred. Combined with the `cost` field (§5), the
  metered-spend column can use the harness's own figure on native + key.
- The OAuth console login (follow-up under req 4): new `LoginIntegrationId`
  ("opencode-console"), an auth manager, and the docs/268 credential-home
  symlink caveats apply (`AGENT_CREDENTIAL_PATHS` already lists
  `.local/share/opencode/` ✅). The §2 console-reachability observation is a
  design input for it.

## 7. Live verification status (2026-08-17) and what still needs a real key

Done live, no key:

- ✅ Real completion over `chat/completions` (free model), including usage
  payload and `cost` field.
- ✅ Route existence + model-registry checks on all three styles, both
  products' bases.
- ✅ **Auth-header matrix** by invalid-key differential ("Invalid API key"
  proves the header was read; "Missing API key" proves it was ignored):
  `/chat/completions` Bearer-only; `/responses` Bearer-only; `/messages`
  x-api-key-only; Go `chat/completions` Bearer ✅.
- ✅ No cross-style translation (free-model probe, §3).
- ✅ Vendor docs: products, prices, caps, auto-reload, workspace limits, Go
  model list, per-model endpoints/styles.

Still needs a real key (per req 5's "live verification needed"):

1. One real paid turn per (product × style) — Zen `A_MSG`/`O_RESP`/`O_CC`,
   Go `O_CC`/`O_RESP`(/`A_MSG` if any Go model still publishes it).
2. Claude Code and Codex driven end-to-end at Zen/Go (the actual cross-harness
   pairs, docs/252 pair-verification method) — settles `carriers` empirically.
3. The Go cap-exceeded shape (expected 429 `UsageLimitError`-family, cf. the
   free tier's `FreeUsageLimitError`) and the "Use balance" fallback's
   visibility (expected: none).
4. OAuth device flow end-to-end (token on the wire, refresh, console
   reachability requirement).
5. Re-pull live models.dev / vendor tables at row-authoring time (§4 drift).

## 8. Go quota — investigation findings ("figure out first")

Searched: the CLI binary (env vars, console client, error vocabulary), the
console SPA and its lazy chunks, candidate REST endpoints, vendor docs.

- **No per-key usage/quota API exists** as far as this investigation could
  find: `console.opencode.ai/api/{usage,billing,me,account,balance,plan}` all
  404 ✅; the CLI contains no usage-reporting client for Zen/Go ✅; vendor
  docs document no such endpoint ✅.
- What exists instead ✅: per-request `cost` in every response body; a 429
  limit-error family (observed live: `FreeUsageLimitError`); **console-UI
  usage reporting** (per-model / per-member / 24h / 7d / 30d CSV exports,
  `cost_micro_cents`, `billing_source: managed-inference | byok | free`)
  behind console-session auth — reachable programmatically only via the
  console OAuth token, i.e. the follow-up login integration, not the launch
  key.
- Consequence for the catalogue: the honest options were (a) planning#339
  shape — a `QuotaIntegrationId` with no reader, generic 429 refusal-memory
  benching — or (b) local accumulation of the `cost` field against the
  published caps. **(a) was chosen** (requirements req 6, 2026-08-17
  receipt); (b) stays available as a later upgrade if a quota display is
  wanted before a real usage API appears.
