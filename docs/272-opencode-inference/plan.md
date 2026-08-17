---
issue: planning#431
title: OpenCode inference — fact sheet and design assessment
description: Verified facts about OpenCode Zen / Go (endpoints, auth, wire styles, models, billing, quota) and the proposed catalogue shape. Investigation complete — all requirements questions resolved.
---

# OpenCode inference — fact sheet and design assessment

Implements nothing yet. This is the investigation deliverable for
[requirements.md](./requirements.md): what OpenCode's hosted inference *is*,
established empirically, and how it would land in the docs/252 catalogue.
All requirements questions are resolved (2026-08-17 receipts); implementation
can start, with §7's real-key items as its live-verification phase.

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

## 6. The catalogue shape — proposed here, and now built

**Built on 2026-08-17**, as described below, with three departures the section
records inline: the launch `carriers` gate (req 5), the model rows that gate
excludes, and `nativeService` staying deferred. Key files:
`src/server/shared/catalogue/services.ts` (the rows),
`catalogue/types.ts` (`opencode-go-usage`),
`catalogue/model-identity.ts` (Zen's Haiku spelling),
`client/components/Settings/ServicesPanel.tsx` (the Go hazard notice),
`client/components/ServiceLogo.tsx`, `orchestrator/egress-allowlist.ts` +
`egress-firewall.ts` (`opencode.ai`). Remaining work:
[checklist.md](./checklist.md).

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
    "OPENCODE_ZEN_API_KEY" }]`. Endpoints per style: `A_MSG:
    "https://opencode.ai/zen"` (Claude-style base, per the docs/268 `/v1`
    convention), `O_RESP: "https://opencode.ai/zen/v1"`, `O_CC:
    "https://opencode.ai/zen/v1"`. Free models are ordinary $0 rows of this
    mode (resolved requirements question); the anonymous no-credential tier is
    out of scope.
    - **As built**: the storage names are `OPENCODE_API_KEY` (Zen) and
      `OPENCODE_GO_API_KEY` (Go). Two names for one pasted key is what keeps
      the two credentials separable, and it also answers the dedup worry above
      — the credential surfaces are keyed by `(service, mode)`, so a stored Zen
      key cannot stand in for a Go one. Zen's name is the vendor's own, as
      DeepSeek's row uses `DEEPSEEK_API_KEY`, so a deployment exporting the
      documented variable has it adopted at boot (docs/252 req 20). That it is
      ALSO a name `HARNESS_CREDENTIAL_VARS.opencode` scrubs is safe rather than
      circular, and the reason is worth stating because it looks like a
      collision: the scrub empties the SPAWN env, so the CLI cannot auto-detect
      the key and out-prefer ShipIt's provider block, while the adapter reads
      the secret from its own `process.env` and writes
      `OPENCODE_PROVIDER_API_KEY` (`opencode/adapter.ts`). `O_RESP` is declared
      by neither mode as built — see the carriers note below. The free rows
      stay unauthored: each duplicates a paid row in rate-limited form, and
      none is a frontier coding model, which is the subset rule the list
      follows.
  - `{ kind: "sub", quota: <new "opencode-go-usage"> }` — OpenCode Go, the
    GLM-coding-plan shape (sub-via-string, same key). Endpoints as above with
    `/zen/go`. Quota: **decided (req 6)** — a new `QuotaIntegrationId`
    (`opencode-go-usage`) that reports nothing until a per-key source exists,
    with generic 429 refusal-memory benching; the Go settings surface carries
    the "Use balance" warning (§5, §8). That is the state GLM's plan was in
    before planning#339 wrote its reader — with one difference worth keeping in
    view: GLM was waiting for a reader somebody could write, and here there is
    no usage API to read at all.
- **The two-mode shape is what ships, and req 7 says it is not the end state.**
  Nik's PR review: one key and one authentication flow serve both products, so
  asking the user which product their key is for — and asking for the same key
  twice — is a distinction ShipIt invented. Anthropic earns its mode choice
  because a subscription and an API key authenticate differently; OpenCode does
  not. Deferred by the same answer to a follow-up after this PR merges; the
  open design questions are in [checklist.md](./checklist.md). Until then the
  two slots take the same pasted key, which works.
- **Per-model `styles` come straight from the vendor's per-model endpoint
  rows** (§3) — the live pass measured that the gateway does not translate
  across styles, so a model is declared under exactly its published style.
  Each mode's string credential needs no `targetOverride` (the header matrix
  matches every harness's default), and no `carriers` restriction is
  indicated: an ordinary API key that works wherever the wire format does is
  the exact "absent means any harness with a string target" case — subject to
  the real-key pair runs in §7.
  - **As built, both credentials DO carry `carriers: ["opencode"]`, and it is
    a launch gate rather than a wire fact.** Req 5 offers a cross-harness pair
    only after live verification shows it works, and the paid sweep in §7 needs
    a key nobody has run yet; the header matrix says the credential *would*
    authenticate on all three harnesses, which is not the same claim. So the
    service launches on the harness whose own CLI exercises it, and the gate
    lifts one measured pair at a time by deleting the line. Two consequences
    worth stating: Zen's Claude-family rows are offered on OpenCode only even
    though Claude Code speaks their style, and the `@ai-sdk/openai` rows
    (GPT-5.6 Sol/Terra/Luna, Grok 4.6, Go's Luna and Grok 4.5) are **not
    authored at all** — `openai-responses` is Codex's style alone, so under the
    gate they would be rows no harness could reach.
  - **Row-authoring source, as built**: the vendor's own per-model endpoint
    table (`opencode.ai/docs/zen`, `/docs/go`) cross-checked against live
    models.dev — they agree everywhere except the Go Qwen rows, where the docs
    say `/messages` and models.dev says chat-completions. Every authored id was
    then re-verified per product with a no-key probe: the registry check runs
    BEFORE the auth check, so a served id answers `AuthError: Missing API key`
    and an absent one `ModelError`. Negative controls: `glm-5.3` and
    `qwen3.8-max` are ModelError at Zen, `claude-opus-5` and `grok-4.6` are
    ModelError at Go. (One operational note from that pass: `opencode.ai` sits
    behind Cloudflare and answers `403 error code: 1010` to a request with no
    User-Agent. Both CLIs send one; a bare `fetch` probe must.)
- `HarnessDef.opencode` gains `nativeService: "opencode"` — the follow-up
  docs/268's catalogue row deferred. Combined with the `cost` field (§5), the
  metered-spend column can use the harness's own figure on native + key.
  - **Done, and it needed three consumers fixed first** — the whole content of
    this line is that "native service" had been standing in for "the vendor's
    account machinery owns this", which is true of Anthropic and OpenAI and
    false here: OpenCode's native service is a pasted key with no login flow,
    and an unshaped OpenCode spawn cannot authenticate at all (the adapter
    refuses a turn with no routing). Each of the three now asks
    `loginIntegrationForService` as well:
    - `session-agent-env.ts` — the planning#353 write. It skipped settling a
      selection-less turn's model onto the row for the native vendor, because
      the older fallback reaches the same ACCOUNT credential there. Left
      unfixed, naming a native service would have sent a selection-less
      OpenCode turn into a spawn with no credential.
    - `session-agent-env.ts` — the blocked-turn subject, which would otherwise
      say "every connected OpenCode account…" about a service with no accounts.
    - `credential-failure-policy.ts` — `vendorOwnedRecovery`, which would have
      sent a refused OpenCode credential down a heal path that heals nothing
      and re-selected it every turn (the GLM bug the axis exists for).
    - and `services/settings.ts`, where the account verbs must keep answering
      400 for OpenCode.
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
