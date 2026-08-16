/**
 * docs/252 phase 1 — the services ShipIt ships, and the models it maintains for
 * each.
 *
 * A **service** is a credentialed source of models. Every service here is
 * ShipIt's: a user supplies a credential for one, they never author one (req 7).
 * The launch set is itself a requirement (req 15) — first-party Anthropic and
 * OpenAI as ordinary rows, DeepSeek as the direct key-authenticated case,
 * OpenRouter and Vercel AI Gateway as the gateways, and GLM as the custom
 * service carrying a subscription alongside its API key.
 *
 * The model lists are a **maintained subset**, not a mirror (req 6). Only a
 * handful of models are worth using for coding at any moment, so a gateway
 * advertising hundreds contributes a short curated list. Breadth is a judgement
 * ShipIt makes and revises.
 *
 * ## Who each model is
 *
 * Every row spreads an identity from `model-identity.ts`
 * (`...MODEL_IDENTITIES.opus5`), which supplies its `canonicalModelKey` and its
 * `family` together. Do NOT type the two fields into a row: declaring them once
 * and referencing them is what makes a mismatched pair unwritable, and a
 * free-form string copied per offering is exactly the typo that would make
 * ShipIt call a same-model review independent (docs/261 req 4).
 *
 * A new service offering a model already listed here adds NO declaration — it
 * references the existing one, which is what proves that OpenRouter's
 * `anthropic/claude-opus-5` and Anthropic's `claude-opus-5` are one model.
 *
 * ## Where the numbers came from
 *
 * `price` is ALWAYS the service's published API rate per **million** tokens —
 * never the incremental cost of a turn (see `ModelPrice`). Every figure below
 * was read from the vendor's own documentation on **2026-08-09**; prices move
 * more often than model lists do, so treat this block as the thing to re-check
 * when a row is revised.
 *
 * | Service    | Source                                                             |
 * |------------|--------------------------------------------------------------------|
 * | Anthropic  | `platform.claude.com/docs/en/pricing` (via the bundled `claude-api` skill's cached model table) + `docs/en/build-with-claude/prompt-caching` for the cache multipliers |
 * | OpenAI     | `developers.openai.com/api/docs/models/<id>` per model, one page each; cache-write rule from `developers.openai.com/api/docs/guides/prompt-caching` |
 * | DeepSeek   | `deepseek.ai/pricing` (corroborated against OpenRouter's model pages) |
 * | GLM (Z.ai) | `z.ai/model-api` + `docs.z.ai/devpack/quick-start` (coding plan endpoint and auth) |
 * | Gateways   | Each gateway's OWN published rate, read from its public model endpoint — see the correction below. |
 *
 * **CORRECTION (2026-08-16): a gateway is not a pass-through.** This block used
 * to assert that both gateways bill at the upstream provider's list rate, and
 * that each gateway row could therefore reuse its upstream's price constant.
 * `GET https://openrouter.ai/api/v1/models` and
 * `GET https://ai-gateway.vercel.sh/v1/models` — both public and unauthenticated
 * — disagree, in both directions and by large multiples:
 *
 * | Model            | Vendor direct | OpenRouter    | Vercel      |
 * |------------------|---------------|---------------|-------------|
 * | DeepSeek V4 Flash| 0.14 / 0.28   | 0.061 / 0.123 | 0.20 / 0.40 |
 * | DeepSeek V4 Pro  | 0.435 / 0.87  | 1.168 / 2.336 | 1.74 / 3.48 |
 * | GLM-5.2          | 1.40 / 4.40   | 0.308 / 0.968 | 1.10 / 3.851|
 * | GPT-5.6 Terra    | 2.00 / 12.00  | 1.00 / 6.00   | 2.00 / 12.00|
 *
 * So each gateway now carries its own constants (`OPENROUTER_PRICES`,
 * `VERCEL_PRICES`) and reuses an upstream constant ONLY where the two figures
 * were checked and found equal — which is the whole Anthropic line, plus GPT-5.6
 * Sol, and nothing else. Sharing a constant is now a statement that the rates
 * were compared, not an assumption that they must match.
 *
 * OpenRouter's credit-purchase fee is a platform charge rather than a per-token
 * rate and is still deliberately not modelled here.
 *
 * **Cache rates are derived, not separately published, for two vendors:**
 * - *Anthropic* publishes multipliers rather than rates — a cache **read** costs
 *   0.1× the base input rate, a 5-minute cache **write** 1.25× (a 1-hour write
 *   is 2×). ShipIt records a single `cache_create` figure and Claude Code's
 *   default TTL is 5 minutes, so `cacheWrite` uses 1.25×.
 * - *OpenAI* publishes a cached-input rate per model (used verbatim for
 *   `cacheRead`) and a single cache-write rule: **free on models before the
 *   GPT-5.6 family, 1.25× the uncached input rate from GPT-5.6 onward**. A `0`
 *   here therefore means "the vendor charges nothing", which is why the missing
 *   -value sentinel is negative rather than zero.
 *
 * *DeepSeek* and *GLM* publish a cache-hit rate and charge cache misses at the
 * ordinary input rate, so `cacheWrite === input` for those rows.
 *
 * ## Context windows: what ShipIt reports, not what the vendor advertises
 *
 * `contextWindow` feeds the first-frame context dial, and its job is to match
 * what the harness will report once the turn starts. For the GPT-5 family that
 * is Codex's **272K** assignment, not OpenAI's advertised 400K/1.05M maximum —
 * the same deliberate choice the old `MODEL_CONTEXT_WINDOWS` table made, and
 * changing it would move a number on screen, which phase 1 must not do.
 */

import { MODEL_IDENTITIES } from "./model-identity.js";
import type { ServiceDef } from "./types.js";

const A_MSG = "anthropic-messages" as const;
const O_RESP = "openai-responses" as const;
const O_CC = "openai-chat-completions" as const;

/** Anthropic list rates, per million tokens (2026-08-09). */
const ANTHROPIC_PRICES = {
  // $5 / $25; cacheRead 0.1×, cacheWrite 1.25×.
  opus5: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  // Standard $3 / $15. An introductory $2 / $10 runs through 2026-08-31; the
  // standard rate is the durable figure and the one carried here.
  sonnet5: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  // Haiku 4.5 — $1 / $5.
  haiku45: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // Fable 5 — $10 / $50.
  fable5: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
} as const;

/**
 * OpenAI list rates, per million tokens (2026-08-09). `cacheRead` is the
 * published cached-input rate; `cacheWrite` is 1.25× input for the GPT-5.6
 * family and **0** (free) for everything older.
 */
const OPENAI_PRICES = {
  sol: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  terra: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  luna: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  gpt55: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  gpt54: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  gpt54mini: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  gpt53codex: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  gpt52: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
} as const;

/** DeepSeek list rates, per million tokens (2026-08-09). No separate cache-write charge. */
const DEEPSEEK_PRICES = {
  v4flash: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 },
  v4pro: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0.435 },
} as const;

/** Z.ai list rates for GLM-5.2, per million tokens (2026-08-09). */
const GLM_PRICES = {
  glm52: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 },
} as const;

/**
 * OpenRouter's OWN list rates, per million tokens, read from
 * `GET https://openrouter.ai/api/v1/models` on **2026-08-16**. Present only for
 * models where OpenRouter's figure differs from the upstream vendor's — a row
 * whose rates were checked and found equal keeps the upstream constant.
 *
 * `cacheWrite === input` wherever OpenRouter publishes no `input_cache_write`:
 * that is the same convention DeepSeek and GLM use above (a cache miss is billed
 * at the ordinary input rate), and it is a real answer rather than a missing one.
 */
const OPENROUTER_PRICES = {
  // Google publishes cache STORAGE per hour rather than a per-token write, so
  // OpenRouter's `input_cache_write` is below its `input_cache_read`. Unusual,
  // and copied verbatim rather than "corrected" upward.
  gemini37flash: { input: 0.375, output: 1.875, cacheRead: 0.0375, cacheWrite: 0.020833 },
  grok46: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2 },
  kimiK3: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
  qwen38max: { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 },
  // Half OpenAI's own rate for the same model. Not a typo — see the correction
  // in this file's header.
  gpt56terra: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
  v4flash: { input: 0.06146, output: 0.12292, cacheRead: 0.012292, cacheWrite: 0.06146 },
  v4pro: { input: 1.168, output: 2.336, cacheRead: 0.09855, cacheWrite: 1.168 },
  glm52: { input: 0.308, output: 0.968, cacheRead: 0.0572, cacheWrite: 0.308 },
} as const;

/**
 * Vercel AI Gateway's OWN list rates, per million tokens, read from
 * `GET https://ai-gateway.vercel.sh/v1/models` on **2026-08-16**. Same rule as
 * {@link OPENROUTER_PRICES}: only the models whose rates differ from upstream.
 */
const VERCEL_PRICES = {
  // Twice OpenRouter's rate for the same Google model.
  gemini37flash: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 },
  grok46: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2 },
  kimiK3: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
  qwen38max: { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 },
  v4flash: { input: 0.2, output: 0.4, cacheRead: 0.04, cacheWrite: 0.2 },
  v4pro: { input: 1.74, output: 3.48, cacheRead: 0.14, cacheWrite: 1.74 },
  glm52: { input: 1.1, output: 3.851, cacheRead: 0.275, cacheWrite: 1.1 },
} as const;

/**
 * What Codex's app-server assigns the GPT-5 family, which is what ShipIt
 * reports and therefore what the dial must show on the first frame. OpenAI
 * advertises larger maxima (400K for GPT-5.2/5.3-codex/5.4-mini, 1.05M for the
 * rest); those are deliberately not used here.
 */
const CODEX_WINDOW = { default: 272_000 } as const;
const ONE_M = { default: 1_000_000 } as const;
/** Grok 4.6's window — the only current model that is neither 200K, 272K nor ~1M. */
const HALF_M = { default: 500_000 } as const;

export const SERVICES = [
  {
    id: "anthropic",
    name: "Anthropic",
    modes: [
      {
        kind: "sub",
        endpoints: { [A_MSG]: "https://api.anthropic.com" },
        quota: "anthropic-oauth-usage",
        credentials: [
          { via: "account", login: "anthropic-oauth" },
          // `claude-env-oauth`: a subscription delivered as an env-supplied
          // OAuth token — quota-bearing, and ranked above the metered key route.
          // It is why `via` (delivery) and `kind` (billing) are separate axes.
          // `carriers`: the token is a Claude-Code OAuth artifact (Bearer
          // semantics; Anthropic prohibits third-party harnesses on
          // subscription auth — docs/268), so no other harness may carry it.
          { via: "string", storageEnv: "ANTHROPIC_AUTH_TOKEN", carriers: ["claude"] },
        ],
        retired: [],
        models: [
          { id: "claude-opus-5", label: "Opus 5", ...MODEL_IDENTITIES.opus5, styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.opus5 },
          { id: "claude-sonnet-5", label: "Sonnet 5", ...MODEL_IDENTITIES.sonnet5, styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.sonnet5 },
          { id: "haiku", label: "Haiku 4.5", ...MODEL_IDENTITIES.haiku45, styles: [A_MSG], contextWindow: { default: 200_000 }, price: ANTHROPIC_PRICES.haiku45 },
          // Fable appears under BOTH modes, which is what phase 1's research
          // settled (catalogue.md's checklist item 4). Anthropic publishes it on
          // the ordinary API at the rate below, a subscription reaches it, and
          // it counts against the plan like any other subscription model — so it
          // is an ordinary row in both modes rather than a `key`-only one.
          //
          // The `METERED_MODELS` set in `ModelAgentSelector.tsx` still claims
          // otherwise ("bills per token (usage-based) rather than against the
          // subscription plan limit"). That is out of date as of 2026-08-09 and
          // is the LAST thing asserting it. Deleting the set is a user-visible
          // change (it drives a `$` icon), so it belongs to phase 3's picker
          // rebuild — see plan.md. Do not resurrect the claim from that comment.
          { id: "claude-fable-5", label: "Fable 5", ...MODEL_IDENTITIES.fable5, styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.fable5 },
        ],
      },
      {
        kind: "key",
        endpoints: { [A_MSG]: "https://api.anthropic.com" },
        credentials: [{ via: "string", storageEnv: "ANTHROPIC_API_KEY" }],
        retired: [],
        models: [
          { id: "claude-opus-5", label: "Opus 5", ...MODEL_IDENTITIES.opus5, styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.opus5 },
          { id: "claude-sonnet-5", label: "Sonnet 5", ...MODEL_IDENTITIES.sonnet5, styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.sonnet5 },
          { id: "haiku", label: "Haiku 4.5", ...MODEL_IDENTITIES.haiku45, styles: [A_MSG], contextWindow: { default: 200_000 }, price: ANTHROPIC_PRICES.haiku45 },
          { id: "claude-fable-5", label: "Fable 5", ...MODEL_IDENTITIES.fable5, styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.fable5 },
        ],
      },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    modes: [
      {
        kind: "sub",
        // Phase 3 correction, measured rather than assumed: Codex appends
        // `/responses` to a provider's `base_url`, so the Responses base URL
        // carries the `/v1`. (The Anthropic style is the other way round —
        // Claude Code appends `/v1/messages` — which is why the two families of
        // base URL below look inconsistent and are not.)
        endpoints: { [O_RESP]: "https://api.openai.com/v1" },
        quota: "openai-chatgpt-usage",
        credentials: [{ via: "account", login: "openai-chatgpt" }],
        // The `gpt-5.6 → gpt-5.6-sol` remap. It arrived as the hand-written
        // `normalizeCodexModelId` shim, which was mode-blind and style-blind —
        // so its placement under both modes under `openai-responses` is this
        // catalogue's reading of it rather than something the shim stated.
        // Phase 8 deleted the shim; this row is now the only statement of it,
        // resolved by `retirementSuccessor` (req 13).
        retired: [{ id: "gpt-5.6", styles: [O_RESP], successors: { [O_RESP]: "gpt-5.6-sol" } }],
        models: [
          { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", ...MODEL_IDENTITIES.gpt56sol, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.sol },
          { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", ...MODEL_IDENTITIES.gpt56terra, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.terra },
          { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", ...MODEL_IDENTITIES.gpt56luna, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.luna },
          { id: "gpt-5.4", label: "GPT-5.4", ...MODEL_IDENTITIES.gpt54, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt54 },
          { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", ...MODEL_IDENTITIES.gpt54mini, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt54mini },
          { id: "gpt-5.5", label: "GPT-5.5", ...MODEL_IDENTITIES.gpt55, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt55 },
          { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", ...MODEL_IDENTITIES.gpt53codex, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt53codex },
          { id: "gpt-5.2", label: "GPT-5.2", ...MODEL_IDENTITIES.gpt52, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt52 },
        ],
      },
      {
        kind: "key",
        // See the `sub` mode above for why the Responses base URL carries `/v1`.
        endpoints: { [O_RESP]: "https://api.openai.com/v1", [O_CC]: "https://api.openai.com/v1" },
        credentials: [{ via: "string", storageEnv: "OPENAI_API_KEY" }],
        retired: [{ id: "gpt-5.6", styles: [O_RESP], successors: { [O_RESP]: "gpt-5.6-sol" } }],
        models: [
          { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", ...MODEL_IDENTITIES.gpt56sol, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.sol },
          { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", ...MODEL_IDENTITIES.gpt56terra, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.terra },
          { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", ...MODEL_IDENTITIES.gpt56luna, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.luna },
          { id: "gpt-5.4", label: "GPT-5.4", ...MODEL_IDENTITIES.gpt54, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt54 },
          { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", ...MODEL_IDENTITIES.gpt54mini, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt54mini },
          { id: "gpt-5.5", label: "GPT-5.5", ...MODEL_IDENTITIES.gpt55, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt55 },
          { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", ...MODEL_IDENTITIES.gpt53codex, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt53codex },
          { id: "gpt-5.2", label: "GPT-5.2", ...MODEL_IDENTITIES.gpt52, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt52 },
        ],
      },
    ],
  },
  {
    // The founding case: a direct, key-authenticated provider with no
    // subscription of any kind, serving an Anthropic-compatible endpoint
    // alongside its OpenAI-compatible ones.
    //
    // DeepSeek now serves the Responses API **natively** at the OpenAI SDK base
    // URL — not a translation proxy — which is what lets its models reach Codex
    // (verified against the real endpoint on 2026-08-13: both models answer and
    // run the apply_patch tool loop through codex-cli 0.146.0). The Responses
    // base URL carries the `/v1` because Codex appends `/responses` to it, the
    // same convention the OpenAI rows use.
    id: "deepseek",
    name: "DeepSeek",
    modes: [
      {
        kind: "key",
        endpoints: {
          [O_CC]: "https://api.deepseek.com",
          [O_RESP]: "https://api.deepseek.com/v1",
          [A_MSG]: "https://api.deepseek.com/anthropic",
        },
        credentials: [{ via: "string", storageEnv: "DEEPSEEK_API_KEY" }],
        retired: [],
        models: [
          { id: "deepseek-v4-flash", label: "V4 Flash", ...MODEL_IDENTITIES.deepseekV4Flash, styles: [O_CC, O_RESP, A_MSG], contextWindow: ONE_M, price: DEEPSEEK_PRICES.v4flash },
          { id: "deepseek-v4-pro", label: "V4 Pro", ...MODEL_IDENTITIES.deepseekV4Pro, styles: [O_CC, O_RESP, A_MSG], contextWindow: ONE_M, price: DEEPSEEK_PRICES.v4pro },
        ],
      },
    ],
  },
  {
    // The launch subscription on a non-first-party service (req 15): a coding
    // plan billed as an allowance while being authenticated with an ordinary
    // API key — which is exactly why `kind` (how you pay) and `via` (how you
    // authenticate) are separate axes. Under a shape where `sub` meant "an
    // account obtained by a login flow", this row could not be declared at all.
    id: "zai",
    name: "GLM (Z.ai)",
    modes: [
      {
        kind: "sub",
        quota: "zai-plan-usage",
        // The coding plan's Anthropic-protocol path. Note it is NOT the general
        // `api/paas/v4` endpoint — using that one is the documented mistake.
        endpoints: { [A_MSG]: "https://api.z.ai/api/anthropic" },
        credentials: [
          {
            via: "string",
            storageEnv: "ZAI_CODING_PLAN_KEY",
            // Z.ai's own docs specify the key goes in ANTHROPIC_AUTH_TOKEN, not
            // ANTHROPIC_API_KEY — a bearer token rather than an `x-api-key`
            // header. This is the override the field exists for.
            targetOverride: { claude: { kind: "env", name: "ANTHROPIC_AUTH_TOKEN" } },
            // And `carriers` is its consequence (docs/268 review finding):
            // OpenCode's anthropic-messages path sends `x-api-key`, exactly the
            // header this plan does not accept — offering the pairing would
            // 401 every turn. Claude Code stays the one carrier until a
            // bearer-delivery path for OpenCode is verified at the wire.
            carriers: ["claude"],
          },
        ],
        retired: [],
        models: [
          // The bracket suffix is part of the id Claude Code must forward:
          // without it the session runs against a smaller default context
          // instead of the model's full 1M window.
          //
          // FINDING (phase 1, recorded in plan.md): the plan's OpenAI-protocol
          // path calls the same model `glm-5.2`, so this model's id differs by
          // API STYLE — something `ModelDef` cannot express, since it has one
          // `id` and many `styles`. Rather than invent a per-style id map in a
          // phase that ships no behaviour, this mode declares only the
          // Anthropic style, which is the path ShipIt would actually drive.
          { id: "glm-5.2[1m]", label: "GLM-5.2", ...MODEL_IDENTITIES.glm52, styles: [A_MSG], contextWindow: ONE_M, price: GLM_PRICES.glm52 },
        ],
      },
      {
        kind: "key",
        endpoints: {
          [O_CC]: "https://api.z.ai/api/paas/v4",
          [A_MSG]: "https://api.z.ai/api/anthropic",
        },
        credentials: [{ via: "string", storageEnv: "ZAI_API_KEY" }],
        retired: [],
        models: [
          { id: "glm-5.2", label: "GLM-5.2", ...MODEL_IDENTITIES.glm52, styles: [O_CC, A_MSG], contextWindow: ONE_M, price: GLM_PRICES.glm52 },
        ],
      },
    ],
  },
  {
    // A gateway needs no mechanism of its own — it is a service with a key that
    // happens to reach many upstream vendors. Curation keeps its hundreds of
    // models to a handful, the selection triple distinguishes its
    // `deepseek-v4-flash` from DeepSeek's own, and attribution names it as the
    // service that billed the turn.
    //
    // Consequence worth stating because it reads as a bug and is not: this key
    // makes Anthropic's and OpenAI's models available to someone with no
    // account at either vendor. That is reqs 2 and 6 behaving as specified.
    id: "openrouter",
    name: "OpenRouter",
    modes: [
      {
        kind: "key",
        endpoints: {
          [O_CC]: "https://openrouter.ai/api/v1",
          // The Responses base carries its own `/v1` because Codex appends
          // `/responses` to it — the same convention the OpenAI and DeepSeek
          // rows use, and deliberately NOT the same string as `A_MSG` below.
          [O_RESP]: "https://openrouter.ai/api/v1",
          // OpenRouter's Anthropic-Messages compatible surface (its "Anthropic
          // Skin"), which Claude Code speaks natively. Base URL excludes the
          // `/v1` the Anthropic path appends.
          [A_MSG]: "https://openrouter.ai/api",
        },
        credentials: [{ via: "string", storageEnv: "OPENROUTER_API_KEY" }],
        retired: [],
        // ✅ 2026-08-15 — OpenRouter DOES serve the Responses API at
        // `https://openrouter.ai/api/v1/responses` (authenticated POST → 200
        // with a genuine `"object":"response"` body; a bogus sibling route on
        // the same base 404s with Vercel's HTML page, so the 200 is routing and
        // not a catch-all). Not just the HTTP surface: a real `codex exec` turn
        // completed over it with `wire_api = "responses"`, on
        // `deepseek/deepseek-v4-flash`. That is what lets this row reach Codex
        // at all, and it settles the 🔍 that used to sit here (planning#391).
        //
        // ✅ 2026-08-16 — `deepseek/deepseek-v4-pro` measured the same way and
        // separately: HTTP 200, `"object":"response"`, `"status":"completed"`,
        // `"model":"deepseek/deepseek-v4-pro"`, output text `PAIR_OK`, against
        // the same bogus-route control. So BOTH ids carrying the style below
        // have been seen to work; neither rides on the other.
        //
        // The style is declared per row rather than across the list, because a
        // gateway model answering does not say the gateway TRANSLATES for an
        // upstream that has no Responses API of its own. Anthropic publishes
        // none, and Z.ai was measured in the 08-15 run NOT to serve one — so
        // those three rows would be asserting a translation layer nobody has
        // seen work, and they keep `A_MSG` (their real path to Claude Code)
        // instead. Adding one is a measurement, not a deduction: the two
        // dated lines above are the standard to meet.
        //
        // Caveat that applies to EVERY gateway row reaching Codex, Vercel's
        // included: a namespaced id is outside Codex's own metadata table, so
        // it warns `Model metadata for '<id>' not found. Defaulting to fallback
        // metadata; this can degrade performance and cause issues.` Non-fatal —
        // the verification turn completed correctly — and not something the
        // catalogue can fix from here.
        //
        // 2026-08-16 — the four `O_CC`-only rows at the bottom are the models
        // this pass added, and their single style is deliberate. Anthropic's and
        // DeepSeek's upstreams publish an Anthropic-Messages API of their own, so
        // `A_MSG` on those rows asserts only that OpenRouter forwards a format
        // the upstream already speaks. Google, xAI, Moonshot and Alibaba publish
        // no such surface, so `A_MSG` (or `O_RESP`) on a Gemini/Grok/Kimi/Qwen
        // row would assert a gateway TRANSLATION layer nobody here has seen
        // work — the same claim the dated ✅ notes above exist to avoid making.
        // `O_CC` needs no such claim: it is OpenRouter's own native API.
        //
        // The cost of that honesty, stated plainly: `openai-chat-completions` is
        // spoken by OpenCode alone, and the default install is
        // `SHIPIT_HARNESSES=claude,codex`. So these four reach a default install
        // through NO harness until someone measures the wider styles. Doing so is
        // cheap — one OpenRouter key, one Claude Code turn against
        // `https://openrouter.ai/api` and one `codex exec` against
        // `https://openrouter.ai/api/v1` — and it is the single highest-value
        // follow-up on this file.
        //
        // Deliberately NOT added: `openai/gpt-5.6-sol` and `openai/gpt-5.6-terra`.
        // OpenRouter serves both, but ShipIt already reaches them under two
        // services (OpenAI direct, both modes; Vercel with a measured `O_RESP`),
        // and a third `O_CC`-only path would add a picker row that no default
        // install can run AND force a second context-window convention: every
        // GPT row here carries Codex's assigned 272K, which is the wrong number
        // for a row Codex cannot reach. Add them WITH `O_RESP`, once measured.
        models: [
          { id: "anthropic/claude-opus-5", label: "Opus 5", ...MODEL_IDENTITIES.opus5, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: ANTHROPIC_PRICES.opus5 },
          { id: "anthropic/claude-sonnet-5", label: "Sonnet 5", ...MODEL_IDENTITIES.sonnet5, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: ANTHROPIC_PRICES.sonnet5 },
          // Fable 5 leads SWE-bench Pro (80.3%) and sits second on the public
          // intelligence ranking behind Opus 5, so a curated coding list that
          // omits it is missing a top-two model. `A_MSG` is the same claim its
          // two siblings above already make, and OpenRouter's rate matches
          // Anthropic's own.
          { id: "anthropic/claude-fable-5", label: "Fable 5", ...MODEL_IDENTITIES.fable5, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: ANTHROPIC_PRICES.fable5 },
          { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", ...MODEL_IDENTITIES.deepseekV4Flash, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: OPENROUTER_PRICES.v4flash },
          { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", ...MODEL_IDENTITIES.deepseekV4Pro, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: OPENROUTER_PRICES.v4pro },
          { id: "z-ai/glm-5.2", label: "GLM-5.2", ...MODEL_IDENTITIES.glm52, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: OPENROUTER_PRICES.glm52 },
          // Grok 4.6 (2026-08-12) scores an agentic-work Elo behind only Opus 5,
          // and is statistically level with Fable 5 and Qwen3.8 Max.
          { id: "x-ai/grok-4.6", label: "Grok 4.6", ...MODEL_IDENTITIES.grok46, styles: [A_MSG, O_CC, O_RESP], contextWindow: HALF_M, price: OPENROUTER_PRICES.grok46 },
          // Gemini 3.7 Flash (2026-08-13) is the cheapest frontier-adjacent agent
          // model on either gateway — an order of magnitude under Grok and Kimi.
          { id: "google/gemini-3.7-flash", label: "Gemini 3.7 Flash", ...MODEL_IDENTITIES.gemini37flash, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: OPENROUTER_PRICES.gemini37flash },
          // Kimi K3 leads Terminal-Bench 2.1 (88.3%) and is the strongest
          // open-weight all-rounder.
          { id: "moonshotai/kimi-k3", label: "Kimi K3", ...MODEL_IDENTITIES.kimiK3, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: OPENROUTER_PRICES.kimiK3 },
          { id: "qwen/qwen3.8-max", label: "Qwen3.8 Max", ...MODEL_IDENTITIES.qwen38max, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: OPENROUTER_PRICES.qwen38max },
        ],
      },
    ],
  },
  {
    id: "vercel",
    name: "Vercel AI Gateway",
    modes: [
      {
        kind: "key",
        endpoints: {
          [O_CC]: "https://ai-gateway.vercel.sh/v1",
          [O_RESP]: "https://ai-gateway.vercel.sh/v1",
          // The Anthropic SDK's base URL omits `/v1`, which it appends itself.
          [A_MSG]: "https://ai-gateway.vercel.sh",
        },
        // Vercel's own docs call this `AI_GATEWAY_API_KEY`, and we deliberately
        // do not. A `storageEnv` names the slot ShipIt reads a secret *from*,
        // and every other row names its service (`OPENROUTER_API_KEY`,
        // `ZAI_API_KEY`, …) — a bare `AI_GATEWAY_*` identifies none, while this
        // service's id is `vercel`. The name is ours to choose because it never
        // leaves ShipIt: `applyServiceRouting` copies the value into the
        // *harness's* variable at spawn, so nothing downstream reads this one.
        credentials: [{ via: "string", storageEnv: "VERCEL_AI_GATEWAY_API_KEY" }],
        retired: [],
        // The style rule this row follows is the one written out on the
        // OpenRouter row above, and for the same reason: `A_MSG` is declared only
        // where the UPSTREAM publishes an Anthropic-Messages API of its own, so
        // the four vendors added on 2026-08-16 carry Vercel's native `O_CC` and
        // nothing else until someone measures wider. Note that `A_MSG` here is
        // also the one style Vercel does not document as covering its whole
        // catalogue, which is why the Z.ai row below is `O_CC`-only even though
        // Z.ai does publish an Anthropic surface upstream — OpenRouter's z-ai
        // pairing was measured, this gateway's was not, and a measurement at one
        // gateway says nothing about the other.
        models: [
          { id: "anthropic/claude-opus-5", label: "Opus 5", ...MODEL_IDENTITIES.opus5, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: ANTHROPIC_PRICES.opus5 },
          { id: "anthropic/claude-sonnet-5", label: "Sonnet 5", ...MODEL_IDENTITIES.sonnet5, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: ANTHROPIC_PRICES.sonnet5 },
          { id: "anthropic/claude-fable-5", label: "Fable 5", ...MODEL_IDENTITIES.fable5, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: ANTHROPIC_PRICES.fable5 },
          // Vercel documents a Responses-compatible surface, so these reach
          // Codex as well as any OpenAI-chat-completions consumer. They also
          // carry the namespaced-id caveat written out on the OpenRouter row
          // above: Codex has no metadata for `openai/gpt-…` and warns before
          // falling back. Non-fatal, and not fixable from the catalogue.
          { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", ...MODEL_IDENTITIES.gpt56sol, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.sol },
          { id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra", ...MODEL_IDENTITIES.gpt56terra, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.terra },
          { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", ...MODEL_IDENTITIES.deepseekV4Flash, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: VERCEL_PRICES.v4flash },
          // V4 Pro holds the SWE-bench Verified record (80.6%) under an MIT
          // licence; only V4 Flash was listed here before. `A_MSG` is the claim
          // the Flash row beside it already makes — same gateway, same upstream.
          { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", ...MODEL_IDENTITIES.deepseekV4Pro, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: VERCEL_PRICES.v4pro },
          { id: "zai/glm-5.2", label: "GLM-5.2", ...MODEL_IDENTITIES.glm52, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: VERCEL_PRICES.glm52 },
          { id: "xai/grok-4.6", label: "Grok 4.6", ...MODEL_IDENTITIES.grok46, styles: [A_MSG, O_CC, O_RESP], contextWindow: HALF_M, price: VERCEL_PRICES.grok46 },
          { id: "google/gemini-3.7-flash", label: "Gemini 3.7 Flash", ...MODEL_IDENTITIES.gemini37flash, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: VERCEL_PRICES.gemini37flash },
          { id: "moonshotai/kimi-k3", label: "Kimi K3", ...MODEL_IDENTITIES.kimiK3, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: VERCEL_PRICES.kimiK3 },
          { id: "alibaba/qwen3.8-max", label: "Qwen3.8 Max", ...MODEL_IDENTITIES.qwen38max, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: VERCEL_PRICES.qwen38max },
        ],
      },
    ],
  },
] as const satisfies readonly ServiceDef[];

/**
 * `ServiceId` is DERIVED from the rows, not declared ahead of them — which is
 * what makes the literal-union claim real rather than aspirational, and avoids
 * naming every id twice. A typo in a credential lookup is a compile error.
 */
export type ServiceId = (typeof SERVICES)[number]["id"];
