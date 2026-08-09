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
 * | Gateways   | Both publish **pass-through** pricing at the upstream provider's list rate, so each gateway row carries the same rates as its upstream row. Vercel documents zero markup explicitly; OpenRouter's credit-purchase fee is a platform charge, not a per-token rate, and is deliberately not modelled here. |
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
 * What Codex's app-server assigns the GPT-5 family, which is what ShipIt
 * reports and therefore what the dial must show on the first frame. OpenAI
 * advertises larger maxima (400K for GPT-5.2/5.3-codex/5.4-mini, 1.05M for the
 * rest); those are deliberately not used here.
 */
const CODEX_WINDOW = { default: 272_000 } as const;
const ONE_M = { default: 1_000_000 } as const;

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
          { via: "string", storageEnv: "ANTHROPIC_AUTH_TOKEN" },
        ],
        retired: [],
        models: [
          { id: "claude-opus-5", label: "Opus 5", styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.opus5 },
          { id: "claude-sonnet-5", label: "Sonnet 5", styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.sonnet5 },
          { id: "haiku", label: "Haiku 4.5", styles: [A_MSG], contextWindow: { default: 200_000 }, price: ANTHROPIC_PRICES.haiku45 },
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
          { id: "claude-fable-5", label: "Fable 5", styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.fable5 },
        ],
      },
      {
        kind: "key",
        endpoints: { [A_MSG]: "https://api.anthropic.com" },
        credentials: [{ via: "string", storageEnv: "ANTHROPIC_API_KEY" }],
        retired: [],
        models: [
          { id: "claude-opus-5", label: "Opus 5", styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.opus5 },
          { id: "claude-sonnet-5", label: "Sonnet 5", styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.sonnet5 },
          { id: "haiku", label: "Haiku 4.5", styles: [A_MSG], contextWindow: { default: 200_000 }, price: ANTHROPIC_PRICES.haiku45 },
          { id: "claude-fable-5", label: "Fable 5", styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.fable5 },
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
        endpoints: { [O_RESP]: "https://api.openai.com" },
        quota: "openai-chatgpt-usage",
        credentials: [{ via: "account", login: "openai-chatgpt" }],
        // The `gpt-5.6 → gpt-5.6-sol` remap is today's `normalizeCodexModelId`
        // shim, generalized. The shim is mode-blind and style-blind, so its
        // placement under both modes under `openai-responses` is this
        // catalogue's reading of it rather than something the shim states.
        retired: [{ id: "gpt-5.6", styles: [O_RESP], successors: { [O_RESP]: "gpt-5.6-sol" } }],
        models: [
          { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.sol },
          { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.terra },
          { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.luna },
          { id: "gpt-5.4", label: "GPT-5.4", styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt54 },
          { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt54mini },
          { id: "gpt-5.5", label: "GPT-5.5", styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt55 },
          { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt53codex },
          { id: "gpt-5.2", label: "GPT-5.2", styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt52 },
        ],
      },
      {
        kind: "key",
        endpoints: { [O_RESP]: "https://api.openai.com", [O_CC]: "https://api.openai.com" },
        credentials: [{ via: "string", storageEnv: "OPENAI_API_KEY" }],
        retired: [{ id: "gpt-5.6", styles: [O_RESP], successors: { [O_RESP]: "gpt-5.6-sol" } }],
        models: [
          { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.sol },
          { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.terra },
          { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.luna },
          { id: "gpt-5.4", label: "GPT-5.4", styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt54 },
          { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt54mini },
          { id: "gpt-5.5", label: "GPT-5.5", styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt55 },
          { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt53codex },
          { id: "gpt-5.2", label: "GPT-5.2", styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt52 },
        ],
      },
    ],
  },
  {
    // The founding case: a direct, key-authenticated provider with no
    // subscription of any kind, serving an Anthropic-compatible endpoint
    // alongside its OpenAI-compatible one.
    id: "deepseek",
    name: "DeepSeek",
    modes: [
      {
        kind: "key",
        endpoints: {
          [O_CC]: "https://api.deepseek.com",
          [A_MSG]: "https://api.deepseek.com/anthropic",
        },
        credentials: [{ via: "string", storageEnv: "DEEPSEEK_API_KEY" }],
        retired: [],
        models: [
          { id: "deepseek-v4-flash", label: "V4 Flash", styles: [O_CC, A_MSG], contextWindow: ONE_M, price: DEEPSEEK_PRICES.v4flash },
          { id: "deepseek-v4-pro", label: "V4 Pro", styles: [O_CC, A_MSG], contextWindow: ONE_M, price: DEEPSEEK_PRICES.v4pro },
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
          { id: "glm-5.2[1m]", label: "GLM-5.2", styles: [A_MSG], contextWindow: ONE_M, price: GLM_PRICES.glm52 },
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
          { id: "glm-5.2", label: "GLM-5.2", styles: [O_CC, A_MSG], contextWindow: ONE_M, price: GLM_PRICES.glm52 },
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
          // OpenRouter's Anthropic-Messages compatible surface (its "Anthropic
          // Skin"), which Claude Code speaks natively. Base URL excludes the
          // `/v1` the Anthropic path appends.
          [A_MSG]: "https://openrouter.ai/api",
        },
        credentials: [{ via: "string", storageEnv: "OPENROUTER_API_KEY" }],
        retired: [],
        // 🔍 Whether OpenRouter serves the Responses API is not established, so
        // no model here declares `openai-responses` — which means this row
        // reaches Claude Code and not Codex today. If the Responses surface is
        // confirmed, adding the style to these rows is the whole change.
        models: [
          { id: "anthropic/claude-opus-5", label: "Opus 5", styles: [A_MSG, O_CC], contextWindow: ONE_M, price: ANTHROPIC_PRICES.opus5 },
          { id: "anthropic/claude-sonnet-5", label: "Sonnet 5", styles: [A_MSG, O_CC], contextWindow: ONE_M, price: ANTHROPIC_PRICES.sonnet5 },
          { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", styles: [A_MSG, O_CC], contextWindow: ONE_M, price: DEEPSEEK_PRICES.v4flash },
          { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", styles: [A_MSG, O_CC], contextWindow: ONE_M, price: DEEPSEEK_PRICES.v4pro },
          { id: "z-ai/glm-5.2", label: "GLM-5.2", styles: [A_MSG, O_CC], contextWindow: ONE_M, price: GLM_PRICES.glm52 },
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
        credentials: [{ via: "string", storageEnv: "AI_GATEWAY_API_KEY" }],
        retired: [],
        models: [
          { id: "anthropic/claude-opus-5", label: "Opus 5", styles: [A_MSG, O_CC], contextWindow: ONE_M, price: ANTHROPIC_PRICES.opus5 },
          { id: "anthropic/claude-sonnet-5", label: "Sonnet 5", styles: [A_MSG, O_CC], contextWindow: ONE_M, price: ANTHROPIC_PRICES.sonnet5 },
          // Vercel documents a Responses-compatible surface, so these reach
          // Codex as well as any OpenAI-chat-completions consumer.
          { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.sol },
          { id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra", styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.terra },
          { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", styles: [A_MSG, O_CC], contextWindow: ONE_M, price: DEEPSEEK_PRICES.v4flash },
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
