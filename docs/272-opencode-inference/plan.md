---
issue: planning#431
title: OpenCode inference — fact sheet and design assessment
description: Verified facts about OpenCode Zen / Go (endpoints, auth, wire styles, models, billing) and the proposed catalogue shape. Investigation only — no implementation while requirements.md has open questions.
---

# OpenCode inference — fact sheet and design assessment

Implements nothing yet. This is the investigation deliverable for
[requirements.md](./requirements.md): what OpenCode's hosted inference *is*,
established empirically where possible, and how it would land in the docs/252
catalogue. Open questions live in requirements.md and gate implementation.

**Verification markers** (docs/252 discipline): ✅ = observed — in this
repository, in the pinned `opencode-ai@1.18.15` binary, or at a local HTTP
recorder driven by that binary. 🔍 = documentation or third-party sources, not
verified here. One honest limitation up front: **this session's container has
an egress allowlist** — `opencode.ai`, `console.opencode.ai` and `models.dev`
do not resolve — so every server-side claim (what the live endpoints accept) is
🔍 even where the CLI side is ✅. The wire probes show what the vendor's own CLI
*sends to its own service by default*, which is strong evidence but not a live
turn. A Phase-10-style live sweep needs a real key and open egress.

## 1. What the service is

Two paid products and a free tier, one vendor (Anomaly, the SST team), one
console (`console.opencode.ai`), one API key:

| Product | Shape | Base URL | Models |
|---|---|---|---|
| **OpenCode Zen** | Pay-as-you-go credits (`key`-shaped) | `https://opencode.ai/zen/v1` ✅ | ~60 current, incl. frontier closed (Claude, GPT, Gemini) |
| **OpenCode Go** | $10/month subscription with usage caps (`sub`-shaped) | `https://opencode.ai/zen/go/v1` ✅ | 17 current, open-weight coding set |
| Free tier | No credential (`apiKey: "public"`) | same as Zen | ~8 `*-free` models |

- ✅ Both providers, ids `opencode` and `opencode-go`, their `api` URLs, shared
  `env: ["OPENCODE_API_KEY"]`, and doc pointer `https://opencode.ai/docs/zen` —
  read out of the models.dev snapshot bundled in the pinned CLI binary
  (`opencode-ai@1.18.15`, published 2026-08-07).
- ✅ "OpenCode Go is a $10 per month subscription that provides reliable access
  to popular open coding models" — the CLI's own connect-dialog copy, in the
  binary. The CLI's provider picker pins `opencode` and `opencode-go` to the
  top two slots and tags both "recommended".
- ✅ With no credential at all, the CLI sets the Zen provider's `apiKey` to the
  literal `"public"` and disables every model whose price is non-zero (binary
  logic; also observed — `opencode models` in this container lists only the
  `opencode/*-free` set).
- 🔍 Billing mechanics, consistent across the vendor page snippets and several
  third-party writeups: Zen PAYG bills at upstream list price with zero markup,
  card fees passed through (4.4% + $0.30), and **auto-reloads $20 when the
  balance drops below $5**. Go is $10/month ($5 first month) with
  dollar-denominated caps **$12 / 5 h, $30 / week, $60 / month** (5 h window
  from first request; weekly reset Monday 00:00 UTC).

## 2. Auth modes

- **API key** (req 3): collected at the console, pasted via `opencode auth
  login` or supplied as `OPENCODE_API_KEY` ✅ (binary env list; the wire probes
  below ran on it). Stored by the CLI in `auth.json` at the data root
  (`~/.local/share/opencode`), injectable per docs/268 (`OPENCODE_AUTH_CONTENT`
  inlines the file ✅ binary env list). **One key serves both products** ✅ —
  the same env var authenticated requests to both `/zen/v1/...` and
  `/zen/go/v1/...` at the recorder.
- **Console OAuth** (the login-flow subscription path): the CLI has a device-code
  OAuth integration labeled "OpenCode Console account" against
  `https://console.opencode.ai/auth/device/code`, with refresh-token handling ✅
  (binary). `OPENCODE_CONSOLE_TOKEN` also exists as an env var ✅. How the OAuth
  access token reaches the wire (Bearer? exchanged?) is **unestablished**: with
  a stored credential (auth.json or `OPENCODE_AUTH_CONTENT`) and no env key,
  every probe run hung making no model request — consistent with a console
  round-trip this container's egress blocks — so OAuth-mode behavior needs a
  live probe. ⚠ That hang also means: **a stored-credential OpenCode spawn
  appears to require console reachability**, worth re-checking before any
  login integration.
- Go entitlement is account-side: the CLI's Go dialog says "Go to
  [console] and enable OpenCode Go" ✅ — there is no separate Go key.

## 3. API styles — Zen speaks all three of ShipIt's `ApiStyle`s

Wire-verified at a local recorder by overriding the built-in providers'
`options.baseURL` and running real `opencode run` turns (fake key, so requests
were captured, not completed). **Style is per model family**, selected by the
snapshot's per-model `provider.npm` override:

| Model family (`provider.npm`) | Path observed ✅ | Auth header observed ✅ | ShipIt `ApiStyle` |
|---|---|---|---|
| default (`@ai-sdk/openai-compatible`) — GLM, MiniMax, … | `POST <base>/chat/completions` | `Authorization: Bearer <key>` | `openai-chat-completions` |
| `@ai-sdk/openai` — GPT family | `POST <base>/responses` | `Authorization: Bearer <key>` | `openai-responses` |
| `@ai-sdk/anthropic` — Claude family, most Go models | `POST <base>/messages` | `x-api-key: <key>` + `anthropic-version: 2023-06-01` | `anthropic-messages` |
| `@ai-sdk/google` — Gemini family | `POST <base>/models/<id>:streamGenerateContent` | (not captured) | none — ShipIt has no Google style |

Same picture on the Go base (`/zen/go/v1/chat/completions`,
`/zen/go/v1/responses` observed ✅). Consequences:

- **Cross-harness routing is plausible for all three shipped harnesses.**
  Claude Code (appends `/v1/messages`, sends `x-api-key` from
  `ANTHROPIC_API_KEY` — matching Zen's observed header convention, so likely no
  `targetOverride`) would take an `A_MSG` endpoint of `https://opencode.ai/zen`;
  Codex (appends `/responses`) an `O_RESP` endpoint of
  `https://opencode.ai/zen/v1`; OpenCode's own adapter any of them. **All 🔍
  until a live pair sweep** — the recorder proves the CLI side only, and
  docs/252's rule stands: whether the *server* serves a style for a given model
  is a measurement, not a deduction. (E.g. whether a Claude model answers over
  `chat/completions`, or a GLM model over `/messages`, is unknown.)
- **Gemini models are unrepresentable at launch** unless measured to work over
  `chat/completions` — declaring them would need a fourth `ApiStyle` nothing
  else uses.

## 4. Models and pricing (snapshot of 2026-08-07 ✅; live models.dev is the authoring source)

- **Zen (`opencode`)**: 86 snapshot entries, **60 current** (26 marked
  `deprecated`) — including `claude-opus-5`, `claude-sonnet-5`,
  `claude-fable-5`, `claude-haiku-4-5`, `gpt-5.6-sol/-terra/-luna`, `gpt-5.4`,
  `gpt-5.5(-pro)`, codex variants, `gemini-3.1-pro`/`3.5-flash`, `glm-5.x`,
  `deepseek-v4-flash/-pro`, `kimi-k2.x/k3`, `grok-4.5`, `qwen3.x`, and the
  free set. Snapshot prices carry `cache_read`/`cache_write` and context-tier
  steps — e.g. `claude-sonnet-5` 2/10 (ctx 1M), `claude-fable-5` 10/50 (ctx
  1M), `gpt-5.6-terra` 2.5/15 with a >272K tier, `deepseek-v4-flash` 0.14/0.28.
- **Go (`opencode-go`)**: 23 snapshot entries, **17 current** — the open-weight
  coding set (`glm-5.1/5.2`, `deepseek-v4-flash/-pro`, `kimi-k2.6/k2.7-code/k3`,
  `qwen3.6/3.7/3.8` variants, `minimax-m2.7/m3`, `mimo-v2.5(-pro)`,
  `grok-4.5`, `gpt-5.6-luna`) — several priced *below* their Zen twin
  (`gpt-5.6-luna` 0.1/0.6 vs 0.2/1.2). Under Go these prices meter the caps,
  not a balance.
- **Churn is high** (release/deprecation dates in the snapshot show
  month-scale turnover) — a maintained-subset decision (docs/252 req 6) and
  `RetiredModel` rows will both get real use.
- The CLI namespace is `-m opencode/<model-id>` / `-m opencode-go/<model-id>` ✅,
  but ShipIt's OpenCode adapter never uses the built-in registry — every spawn
  writes its own `shipit` provider block (docs/268), so catalogue rows, not
  models.dev, decide what ShipIt runs.

## 5. Billing hazards

- **Scrub coverage already exists** ✅: `HARNESS_CREDENTIAL_VARS.opencode`
  (`shared/spawn-routing.ts:28`) strips `OPENCODE_API_KEY` and
  `OPENCODE_AUTH_CONTENT` (and the well-known provider keys) from OpenCode
  spawns, so a routed turn cannot silently prefer an ambient Zen credential.
  Claude/Codex rows would deliver the key only into each harness's own target
  variable per `CredentialTargets`.
- **A missed scrub on the Zen key is worse than most**: PAYG **auto-reload**
  ($20 top-up below $5 🔍) means an unintended routing leak spends real,
  uncapped money — there is no plan ceiling on the key mode. Go's caps bound
  the sub mode.
- OpenCode **does** report per-step cost (`step_finish.part.cost`, USD, ✅
  docs/268) — so once an `opencode` ServiceDef exists and becomes the harness's
  `nativeService`, the docs/252 pricing rule's "harness's own figure on
  native + key" cell applies to it, unlike Codex which reports nothing.
- Every OpenCode turn adds a small title-generator side call ✅ (docs/268;
  observed here hitting `gpt-5.4-nano` via `/responses` on Zen) — cost noise
  billed to the same credential.

## 6. Proposed catalogue shape (assessment, not implementation)

- One new `ServiceDef` `{ id: "opencode", name: "OpenCode Zen" }` with two
  modes, matching the two products:
  - `{ kind: "key" }` — Zen PAYG. `credentials: [{ via: "string", storageEnv:
    "OPENCODE_API_KEY" }]`. Endpoints per style: `A_MSG:
    "https://opencode.ai/zen"` (Claude-style base, per the docs/268 `/v1`
    convention), `O_RESP: "https://opencode.ai/zen/v1"`, `O_CC:
    "https://opencode.ai/zen/v1"`.
  - `{ kind: "sub", quota: <new "opencode-go-usage"> }` — OpenCode Go, the
    GLM-coding-plan shape (sub-via-string, same key). Endpoints as above with
    `/zen/go`. Blocked on the quota open question (docs/252's types require
    `quota` on a `sub` mode; no usage API found yet — planning#339 precedent
    says a quota id whose reader reports nothing is acceptable).
- Per-model `styles` authored only from measurement (live sweep); until the
  sweep, the safe launch is each model under the style its own CLI uses
  (§3 table). `ModeCredential.carriers` needs a decision per mode once
  measured — the docs/268 Phase-10 lesson (GLM/Anthropic sub-string leak) says
  get this wrong and the picker offers 401s.
- `HarnessDef.opencode` gains `nativeService: "opencode"` — deliberately
  deferred by docs/268's catalogue row ("would need honest ServiceDef rows —
  follow-up, not this PR"); this is that follow-up.
- The OAuth console login, if in scope later: new `LoginIntegrationId`
  ("opencode-console"), an auth manager, and the docs/268 credential-home
  symlink caveats apply (`AGENT_CREDENTIAL_PATHS` already lists
  `.local/share/opencode/` ✅).
- Free models: no catalogue precedent for a credential-less mode; out of scope
  unless the user asks (requirements open question).

## 7. What a live verification pass must establish (pre-implementation checklist)

1. One real turn per (product × style): Zen `A_MSG`/`O_RESP`/`O_CC`, Go
   `O_CC`/`A_MSG`/`O_RESP` — with a real key, from an open-egress box.
2. Claude Code and Codex each driven at Zen (the cross-harness cells), incl.
   which header the server actually accepts (`x-api-key` vs Bearer on
   `/messages`).
3. Whether a usage/quota endpoint exists for Go caps (console API, response
   headers, 429 shape).
4. OAuth device flow end-to-end: token shape on the wire, refresh, and whether
   stored-credential spawns require console reachability (§2 hang).
5. Live models.dev rows vs this snapshot before authoring model lists.
