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
  /**
   * PROVISIONAL (2026-08-17): Spark is a ChatGPT Pro-only research preview.
   * OpenAI's Codex model guide (`learn.chatgpt.com/docs/models`, checked
   * 2026-08-17) names the exact `gpt-5.3-codex-spark` slug, marks Codex CLI and
   * IDE extension support true, limits availability to ChatGPT Pro, and marks
   * API access false. OpenAI therefore publishes no token price. Reqs 16 and
   * 23 use the closest same-vendor published rate in that case, following the
   * existing GLM-5.3 precedent. Replace this with Spark's own rate if one is
   * published.
   */
  gpt53codexSparkProvisional: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
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
  /**
   * **PROVISIONAL — GLM-5.2's published rate, carried over (2026-08-17).** Z.ai
   * has published no per-token rate for GLM-5.3; the figures circulating
   * third-hand are this same GLM-5.2 row. So this is an ESTIMATE, and it is
   * labelled one rather than dressed as a vendor figure.
   *
   * Shipping it anyway is a deliberate call, and the billing mode is why it is a
   * safe one: GLM-5.3 is offered here under `kind: "sub"`, where {@link ModelPrice}
   * is req 16's *"would have cost"* comparison and never a charge. A coding-plan
   * turn costs the plan, not this number. The basis is also the strongest
   * available: GLM-5.3 is a post-training-only release over the SAME base model,
   * on the SAME plan, rolled out to existing subscribers at no extra cost.
   *
   * The `kind: "key"` row reuses it too, which is the weaker of the two uses
   * because there the number stands in for what the user actually paid. It ships
   * on the same basis and one more: every figure ShipIt derives from these four
   * rates is already surfaced as an *estimate* rather than a billed amount
   * (catalogue.md, Pricing), so the gap between a published rate and this
   * same-vendor, same-base-model carry-over sits inside an approximation the UI
   * already labels. Replace both with the published rate when Z.ai publishes one.
   */
  glm53Provisional: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 },
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
 * OpenCode Zen's OWN list rates, per million tokens, read from live models.dev
 * and the vendor's own `opencode.ai/docs/zen` model table on **2026-08-17**
 * (docs/272).
 *
 * Zen is a gateway sold "at cost", and — exactly like the two gateways above —
 * that does NOT make it a pass-through: it prices **Sonnet 5 at 2/10 where
 * Anthropic charges 3/15**, and **DeepSeek V4 Pro at 1.74/3.84 where DeepSeek
 * charges 0.435/0.87**. So these are its own constants, and a row reuses an
 * upstream one only where the two were compared and found equal (Opus 5, Fable
 * 5, Haiku 4.5, Kimi K3 — all identical to the vendor's published rate).
 *
 * `cacheWrite === input` wherever the source publishes no cache-write rate —
 * the same convention DeepSeek, GLM and OpenRouter use above (a cache miss is
 * billed at the ordinary input rate), and a real answer rather than a missing
 * one.
 */
const OPENCODE_ZEN_PRICES = {
  // Anthropic's own rate for Opus 5, Fable 5 and Haiku 4.5 — checked, equal, so
  // those three rows reuse `ANTHROPIC_PRICES`. Sonnet 5 is where Zen diverges.
  sonnet5: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  v4flash: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0.14 },
  v4pro: { input: 1.74, output: 3.84, cacheRead: 0.145, cacheWrite: 1.74 },
  glm52: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 },
  kimiK3: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
  // The `openai-responses` family (live models.dev, re-pulled 2026-08-17).
  // Sol and Luna match OpenAI's own published rate; **Terra does not** —
  // 2.5/15 here against OpenAI's 2/12 — which is the same reason this service
  // carries its own constants rather than reusing `OPENAI_PRICES`.
  gpt56sol: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  gpt56terra: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
  gpt56luna: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  // Zen publishes no cache-write rate for Grok; 0 is "not charged", not
  // "unknown" — the vendor's table omits the column for this model.
  grok46: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
  // Ox Alpha, free while it is in stealth. Every rate is 0 because the vendor
  // charges nothing — the same "real answer" `cacheWrite: 0` already means, and
  // the reason the missing-value sentinel is negative rather than zero. ✅ live
  // 2026-08-21: a real completion on this id answers `"cost": "0"` in the
  // response body, which is the same field the harness reports spend from
  // (docs/272 §5), so ShipIt's own accounting agrees with the published table.
  //
  // Free is a PROMOTIONAL rate and the vendor says so ("free ... for a limited
  // time"), so this row is the one to re-check first when Zen's price table
  // moves. A priced Ox Alpha is an ordinary edit here, not a new model.
  oxAlpha: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const;

/**
 * OpenCode Go's list rates, per million tokens, same sources and date.
 *
 * Go is a **subscription**, so under {@link ModelPrice} these are req 16's
 * "would have cost" comparison and never a charge — which is also why they may
 * differ from Zen's figures for the same model without either being wrong: Go
 * publishes its own per-model rate for the usage-cap arithmetic (DeepSeek V4
 * Flash 0.22/0.66 here against Zen's 0.14/0.28, V4 Pro 0.66/1.98 against Zen's
 * 1.74/3.84).
 */
const OPENCODE_GO_PRICES = {
  v4flash: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0.22 },
  v4pro: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0.66 },
  glm5x: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 },
  kimiK3: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
  // Go's own rate for Luna is HALF Zen's (0.1/0.6 against 0.2/1.2), which is
  // the clearest single case of why the two products keep separate constants.
  gpt56luna: { input: 0.1, output: 0.6, cacheRead: 0.01, cacheWrite: 0.125 },
} as const;

/**
 * xAI's own published API rates, per million tokens, read from
 * `docs.x.ai/docs/models` on **2026-08-18** and cross-checked against the live
 * `GET https://api.x.ai/v1/models` response captured during the docs/274 Phase 0
 * probe (raw capture: `/persist/grok-capture/models.json`, not in git).
 *
 * The API expresses each rate as an integer 10⁴× the dollars-per-million figure
 * (`grok-4.6` → `prompt_text_token_price: 20000` = $2.00/M); the two sources
 * agree on every row below, which is what makes the unit a checked fact rather
 * than an inferred one.
 *
 * Two deliberate simplifications, both matching how the rest of this file
 * treats the same situations:
 * - **Long-context tier dropped.** xAI doubles every rate above a 200K-token
 *   prompt (`long_context_threshold`). {@link ModelPrice} carries one figure per
 *   axis, so these are the sub-200K rates — the tier a coding turn is
 *   overwhelmingly in. A turn that crosses the threshold is under-costed, the
 *   same way GLM's tiering is.
 * - **`cacheWrite === input`.** xAI publishes a cached-input rate and no
 *   cache-write rate, i.e. a cache miss is billed as ordinary input — the
 *   DeepSeek/GLM convention. Independently corroborated by
 *   {@link OPENROUTER_PRICES}.grok46, authored from OpenRouter's own model
 *   endpoint, which carries the identical `cacheWrite: 2`.
 */
const XAI_PRICES = {
  grok46: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2 },
  // planning#435 — re-read live from `GET https://api.x.ai/v1/models` on
  // 2026-08-19 for the subscription mode's second model
  // (`prompt_text_token_price: 20000`, `cached_prompt_text_token_price: 3000`,
  // `completion_text_token_price: 60000`). It differs from 4.6 in exactly one
  // axis — a cheaper cache read — which is the kind of near-miss that makes
  // copying a sibling's row wrong.
  //
  // A SUBSCRIPTION row still carries the API rate: under a plan it is req 16's
  // "would have cost" comparison rather than what the user paid (see
  // {@link ModelPrice}).
  grok45: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 2 },
  grok43: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 1.25 },
  // The 4.20 line bills identically whether or not it reasons.
  grok420: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 1.25 },
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
          // **Deliberately NO `carriers`**, unlike OpenAI's row below, and the
          // asymmetry is the point rather than an oversight (planning#435).
          //
          // OpenAI's is load-bearing: Grok speaks `openai-responses`, so once it
          // carries an `account` target the style join alone would offer a
          // ChatGPT subscription on Grok. Nothing speaks `anthropic-messages`
          // but Claude Code, so the join already settles this row — and the
          // widening it guards against is ALREADY caught, visibly, by
          // `catalogue.test.ts`'s login fan-out assertion, which pins
          // `["claude"]` precisely so a second anthropic-messages harness shows
          // up as a failing test to review.
          //
          // Adding it "for symmetry" is not free: it makes `(anthropic, sub)`
          // on Codex refuse at `harnessCanCarry`, which deletes the only pair in
          // the real catalogue where "the selected service" and "the harness's
          // vendor" give different answers — the exact axis
          // `service-routing.test.ts` exists to pin (planning#342). That test is
          // worth more than a redundant declaration.
          { via: "account", login: "anthropic-oauth" },
          // `claude-env-oauth`: a subscription delivered as an env-supplied
          // OAuth token — quota-bearing, and ranked above the metered key route.
          // It is why `via` (delivery) and `kind` (billing) are separate axes.
          // `carriers`: the token is a Claude-Code OAuth artifact (Bearer
          // semantics; Anthropic prohibits third-party harnesses on
          // subscription auth — docs/268), so no other harness may carry it.
          // The `targetOverride` is the same shape as GLM's coding plan:
          // Bearer semantics must not inherit Claude's string target
          // `ANTHROPIC_API_KEY`, which the CLI sends as an `x-api-key` header.
          {
            via: "string",
            storageEnv: "ANTHROPIC_AUTH_TOKEN",
            targetOverride: { claude: { kind: "env", name: "ANTHROPIC_AUTH_TOKEN" } },
            carriers: ["claude"],
          },
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
        // `carriers` — a ChatGPT subscription is a login to OpenAI's account
        // system and only Codex can present it. Load-bearing since
        // planning#435: Grok also speaks `openai-responses` and now carries an
        // `account` target, so without this the style join would offer this
        // subscription on Grok and every such turn would 401.
        credentials: [{ via: "account", login: "openai-chatgpt", carriers: ["codex"] }],
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
          // OpenAI lists Spark after the GPT-5.6 family in its recommended Codex
          // models. Keep that vendor order while leaving Sol as the default.
          { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", ...MODEL_IDENTITIES.gpt53codexSpark, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.gpt53codexSparkProvisional },
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
    // docs/274 — xAI, the `grok` harness's native service, and the third
    // first-party vendor row.
    //
    // TWO MODES, and they are two genuinely different offerings rather than one
    // offering with two ways to pay (planning#435, verified live on 2026-08-19
    // with a real SuperGrok login). Different host, different API style, and a
    // DISJOINT model set — `grok-4.5` exists only on the subscription, the 4.20
    // pair and 4.3 only on the key. Only `grok-4.6` is on both, which is why it
    // is one identity spread into both mode rows.
    //
    // That disjointness is also why docs/274 req 17 (subscription ranks above
    // the metered key) is a bigger decision than it looks: preferring the
    // subscription decides which MODELS a session gets, not only who is billed.
    // Nik was asked with that caveat stated and chose it anyway.
    //
    // VERIFIED (docs/274 Phase 0, CLI 1.0.1, against a local HTTP recorder
    // with a dummy key). Pointed at an arbitrary `GROK_XAI_API_BASE_URL` the
    // CLI issues `POST <base>/chat/completions` for an explicit `-m` turn and
    // `POST <base>/responses` for its title side-call — appending nothing, so
    // the base URL carries its own `/v1`, the same convention the OpenAI
    // Responses rows use. Both styles come from ONE CLI, which is why the
    // harness row lists two.
    id: "xai",
    name: "xAI",
    modes: [
      {
        // FIRST, and that is req 17 rather than tidiness: the mode order is
        // what makes a connected SuperGrok subscription rank above the metered
        // key, the way every other connected account outranks a key. Because
        // the two modes offer DISJOINT model sets, this decides which models a
        // Grok session gets and not only who pays — Nik was asked with that
        // caveat stated and chose it anyway (docs/274 Resolved questions).
        kind: "sub",
        // The weekly pool, read by `XaiLimitsProvider` (req 16).
        //
        // This row said `quota: null` — "the vendor publishes nothing to read" —
        // for one release, on a probe that was wrong. `GET /v1/billing` on the
        // host below answers 200 with a CALENDAR-MONTH credit object, all zeros
        // on a subscription, and that 200 was read as proof there was nothing
        // else. `GET /v1/billing?format=credits` — the same path, one query
        // parameter — returns the weekly pool the CLI's own usage screen shows.
        // The lesson is recorded where the reader lives: a 200 that answers a
        // different question is more dangerous than a 404, because a 404 is
        // never mistaken for an answer.
        quota: "xai-plan-usage",
        // ONE style, and a different one from the key mode's. The subscription
        // is a genuinely separate product surface reached at
        // `cli-chat-proxy.grok.com` — a different host, speaking Responses —
        // which is exactly why req 10 makes it a second MODE and not a second
        // credential on the key mode. The CLI reaches this host by itself once
        // `auth.json` authenticates it, so ShipIt sets no base URL for a
        // subscription turn (`serviceRoutingForSelection` returns nothing for
        // an account-delivered credential); the endpoint is declared because a
        // mode whose models name a style must declare it, and because it is
        // what the egress allowlist is authored against.
        endpoints: {
          [O_RESP]: "https://cli-chat-proxy.grok.com/v1",
        },
        // The one and only credential: xAI's own device-code login. `carriers`
        // is not redundant with the style join — Codex also speaks
        // `openai-responses` and carries an account target, so without this the
        // join would offer a SuperGrok subscription to the Codex CLI, which
        // cannot present it.
        credentials: [{ via: "account", login: "xai-oauth", carriers: ["grok"] }],
        retired: [],
        // Req 18 — BOTH models, decided for this mode on its own terms. Req 9's
        // launch set was chosen for key mode and does not constrain this one:
        // `grok-4.5` is superseded at the API and is a current, offered model on
        // the subscription, so leaving it out would hide something the user is
        // paying for.
        //
        // `reasoningEfforts` narrows the harness vocabulary per ROW, and the two
        // rows genuinely disagree: the subscription catalogue declares
        // `supports_reasoning_effort: true` with xhigh/high/medium/low for 4.6
        // and high/medium/low for 4.5. A mode-level list would have to be the
        // intersection and would drop `xhigh` from the top model.
        models: [
          { id: "grok-4.6", label: "Grok 4.6", ...MODEL_IDENTITIES.grok46, styles: [O_RESP], contextWindow: HALF_M, price: XAI_PRICES.grok46, reasoningEfforts: ["xhigh", "high", "medium", "low"] },
          { id: "grok-4.5", label: "Grok 4.5", ...MODEL_IDENTITIES.grok45, styles: [O_RESP], contextWindow: HALF_M, price: XAI_PRICES.grok45, reasoningEfforts: ["high", "medium", "low"] },
        ],
      },
      {
        kind: "key",
        endpoints: {
          [O_CC]: "https://api.x.ai/v1",
          [O_RESP]: "https://api.x.ai/v1",
        },
        credentials: [{ via: "string", storageEnv: "XAI_API_KEY" }],
        retired: [],
        // The launch set is docs/274 req 9, not a mirror of `/v1/models`:
        // grok-4.6 as the top model, grok-4.3, and the 4.20 reasoning /
        // non-reasoning pair the CLI itself defaults to in key mode.
        // Deliberately unauthored from the same live response: `grok-4.5`
        // (superseded by 4.6), `grok-4.20-multi-agent-0309` (an orchestration
        // product, not a coding model), `grok-build-0.1` and the
        // `grok-imagine-*` image/video rows.
        models: [
          { id: "grok-4.6", label: "Grok 4.6", ...MODEL_IDENTITIES.grok46, styles: [O_CC, O_RESP], contextWindow: HALF_M, price: XAI_PRICES.grok46 },
          { id: "grok-4.3", label: "Grok 4.3", ...MODEL_IDENTITIES.grok43, styles: [O_CC, O_RESP], contextWindow: ONE_M, price: XAI_PRICES.grok43 },
          { id: "grok-4.20-0309-reasoning", label: "Grok 4.20 (reasoning)", ...MODEL_IDENTITIES.grok420Reasoning, styles: [O_CC, O_RESP], contextWindow: ONE_M, price: XAI_PRICES.grok420 },
          { id: "grok-4.20-0309-non-reasoning", label: "Grok 4.20", ...MODEL_IDENTITIES.grok420NonReasoning, styles: [O_CC, O_RESP], contextWindow: ONE_M, price: XAI_PRICES.grok420 },
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
          // ✅ 2026-08-17 — GLM-5.3, Z.ai's current frontier coding model
          // (released 08-14), MEASURED on this exact route: `glm-5.3[1m]`
          // completes a Claude Code turn, twice across separate runs, with an
          // impossible-id negative control failing `400 [1214][modelCode: does
          // not exist]` on the same route — so the id is validated and served,
          // not silently defaulted. Evidence: `pair-verification.md`.
          //
          // Listed FIRST because it is the plan's flagship and supersedes 5.2 for
          // coding. That also makes it what `firstEligibleNonTurnSelection` picks
          // for background work on a GLM-only install — deliberate and free,
          // since this is an allowance mode.
          //
          // Its `price` is a labelled ESTIMATE, not a vendor figure — see
          // `GLM_PRICES.glm53Provisional`. Under `sub` that number is only req
          // 16's "would have cost" comparison, never a charge, which is what
          // makes shipping the capability now the right trade.
          { id: "glm-5.3[1m]", label: "GLM-5.3", ...MODEL_IDENTITIES.glm53, styles: [A_MSG], contextWindow: ONE_M, price: GLM_PRICES.glm53Provisional },
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
          // ✅ 2026-08-17 — GLM-5.3 on the metered key, MEASURED: three passing
          // Claude Code turns across two runs, alongside a passing `glm-5.2`
          // control on this same route. Worth stating because it contradicts the
          // vendor: Z.ai's docs still say the general GLM-5.3 API is "coming
          // soon", and it is in fact already serving on the Anthropic path.
          //
          // `A_MSG` ONLY, deliberately — unlike the GLM-5.2 row below, which
          // inherited `O_CC` from an earlier pass. The chat-completions path is
          // reachable only through OpenCode, and that harness did not return a
          // usable verdict here (its turns hung, control included), so declaring
          // `O_CC` would be an assumption. Add it when a turn is seen to work.
          { id: "glm-5.3", label: "GLM-5.3", ...MODEL_IDENTITIES.glm53, styles: [A_MSG], contextWindow: ONE_M, price: GLM_PRICES.glm53Provisional },
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
        // ✅ 2026-08-16 — the rows added this pass were MEASURED, one live turn per
        // (harness, model), serially against the dogfood inner instance. Evidence
        // and per-round detail: `pair-verification.md`. The result settles what
        // this row could previously only guess at, and it is not what the
        // "upstream publishes it" heuristic predicted:
        //
        // **OpenRouter's Anthropic skin translates for EVERY upstream tested** —
        // Grok, Gemini, Kimi and Qwen all completed a Claude Code turn, though
        // xAI, Google, Moonshot and Alibaba publish no Anthropic-Messages API of
        // their own. So the skin is a genuine gateway-side translation, not a
        // pass-through, and `A_MSG` is declared on all four.
        //
        // **Its Responses surface is the opposite: it carries almost nothing.**
        // Only `moonshotai/kimi-k3` completed a Codex turn. Grok, Gemini, Qwen and
        // even `anthropic/claude-fable-5` each failed twice more on re-run, so
        // `O_RESP` is declared on Kimi alone. The DeepSeek rows keep the style
        // they were separately measured with above.
        //
        // Failure mode worth knowing when triaging: every Codex failure surfaced
        // as an EMPTY assistant message with no error text, where the Claude
        // failures surfaced the upstream's own 400. A blank Codex reply on a
        // gateway model is this, not a hung turn.
        //
        // Deliberately NOT added: `openai/gpt-5.6-sol` and `openai/gpt-5.6-terra`.
        // OpenRouter serves both, but ShipIt already reaches them under two
        // services (OpenAI direct, both modes; Vercel with a measured `O_RESP`),
        // and adding them here would force a second context-window convention:
        // every GPT row carries Codex's assigned 272K, which is the wrong number
        // on a gateway whose own figure is 1.05M. Worth doing deliberately, not
        // as a side effect of a curation pass.
        models: [
          { id: "anthropic/claude-opus-5", label: "Opus 5", ...MODEL_IDENTITIES.opus5, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: ANTHROPIC_PRICES.opus5 },
          { id: "anthropic/claude-sonnet-5", label: "Sonnet 5", ...MODEL_IDENTITIES.sonnet5, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: ANTHROPIC_PRICES.sonnet5 },
          // Fable 5 leads SWE-bench Pro (80.3%) and sits second on the public
          // intelligence ranking behind Opus 5, so a curated coding list that
          // omits it is missing a top-two model. OpenRouter's rate matches
          // Anthropic's own. `A_MSG` is measured here, not inherited from the two
          // siblings above — and the distinction earned its keep: the identical
          // inheritance argument for this model at VERCEL predicted a pass on
          // Codex that the sweep refuted.
          { id: "anthropic/claude-fable-5", label: "Fable 5", ...MODEL_IDENTITIES.fable5, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: ANTHROPIC_PRICES.fable5 },
          { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", ...MODEL_IDENTITIES.deepseekV4Flash, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: OPENROUTER_PRICES.v4flash },
          { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", ...MODEL_IDENTITIES.deepseekV4Pro, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: OPENROUTER_PRICES.v4pro },
          { id: "z-ai/glm-5.2", label: "GLM-5.2", ...MODEL_IDENTITIES.glm52, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: OPENROUTER_PRICES.glm52 },
          // Grok 4.6 (2026-08-12) scores an agentic-work Elo behind only Opus 5,
          // and is statistically level with Fable 5 and Qwen3.8 Max.
          { id: "x-ai/grok-4.6", label: "Grok 4.6", ...MODEL_IDENTITIES.grok46, styles: [A_MSG, O_CC], contextWindow: HALF_M, price: OPENROUTER_PRICES.grok46 },
          // Gemini 3.7 Flash (2026-08-13) is the cheapest frontier-adjacent agent
          // model on either gateway — an order of magnitude under Grok and Kimi.
          { id: "google/gemini-3.7-flash", label: "Gemini 3.7 Flash", ...MODEL_IDENTITIES.gemini37flash, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: OPENROUTER_PRICES.gemini37flash },
          // Kimi K3 leads Terminal-Bench 2.1 (88.3%) and is the strongest
          // open-weight all-rounder.
          { id: "moonshotai/kimi-k3", label: "Kimi K3", ...MODEL_IDENTITIES.kimiK3, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: OPENROUTER_PRICES.kimiK3 },
          { id: "qwen/qwen3.8-max", label: "Qwen3.8 Max", ...MODEL_IDENTITIES.qwen38max, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: OPENROUTER_PRICES.qwen38max },
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
        // ✅ 2026-08-16 — measured the same way as the OpenRouter row above (one
        // live turn per (harness, model), serial, `pair-verification.md`), and
        // Vercel turns out to be OpenRouter's MIRROR IMAGE. That is the single
        // most useful fact on these two rows, and neither gateway's docs imply it:
        //
        // **Vercel's Responses surface carries essentially everything** — Grok,
        // Gemini, Kimi, Qwen, GLM-5.2 and DeepSeek V4 Pro all completed a Codex
        // turn, including three upstreams (xAI, Google, Z.ai) that publish no
        // Responses API at all. Where OpenRouter served only Kimi over Responses,
        // Vercel served every model tested but one.
        //
        // **Its Anthropic skin is the weaker of the two**, and fails on exactly
        // one model: `google/gemini-3.7-flash`, twice more on re-run, with a
        // specific and repeatable upstream error — `400 'system messages are only
        // supported at the beginning of the conversation'`. Claude Code's system
        // prompt shape is what the translation cannot carry to Gemini, so that
        // row alone drops `A_MSG` and reaches Codex instead.
        //
        // `anthropic/claude-fable-5` is the one inversion: it passes on the
        // Anthropic skin and fails Codex 4 runs out of 5. Its `O_RESP` is omitted
        // on the majority verdict rather than the single pass.
        //
        // A measurement at one gateway says nothing about the other — z-ai over
        // Responses works HERE and was measured not to at Z.ai's own endpoint.
        models: [
          { id: "anthropic/claude-opus-5", label: "Opus 5", ...MODEL_IDENTITIES.opus5, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: ANTHROPIC_PRICES.opus5 },
          { id: "anthropic/claude-sonnet-5", label: "Sonnet 5", ...MODEL_IDENTITIES.sonnet5, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: ANTHROPIC_PRICES.sonnet5 },
          { id: "anthropic/claude-fable-5", label: "Fable 5", ...MODEL_IDENTITIES.fable5, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: ANTHROPIC_PRICES.fable5 },
          // Vercel documents a Responses-compatible surface, so these reach
          // Codex as well as any OpenAI-chat-completions consumer. They also
          // carry the namespaced-id caveat written out on the OpenRouter row
          // above: Codex has no metadata for `openai/gpt-…` and warns before
          // falling back. Non-fatal, and not fixable from the catalogue.
          { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", ...MODEL_IDENTITIES.gpt56sol, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.sol },
          { id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra", ...MODEL_IDENTITIES.gpt56terra, styles: [O_RESP, O_CC], contextWindow: CODEX_WINDOW, price: OPENAI_PRICES.terra },
          { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", ...MODEL_IDENTITIES.deepseekV4Flash, styles: [A_MSG, O_CC], contextWindow: ONE_M, price: VERCEL_PRICES.v4flash },
          // V4 Pro holds the SWE-bench Verified record (80.6%) under an MIT
          // licence; only V4 Flash was listed here before. Both of its styles are
          // measured rather than carried over from the Flash row beside it.
          { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", ...MODEL_IDENTITIES.deepseekV4Pro, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: VERCEL_PRICES.v4pro },
          { id: "zai/glm-5.2", label: "GLM-5.2", ...MODEL_IDENTITIES.glm52, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: VERCEL_PRICES.glm52 },
          { id: "xai/grok-4.6", label: "Grok 4.6", ...MODEL_IDENTITIES.grok46, styles: [A_MSG, O_CC, O_RESP], contextWindow: HALF_M, price: VERCEL_PRICES.grok46 },
          { id: "google/gemini-3.7-flash", label: "Gemini 3.7 Flash", ...MODEL_IDENTITIES.gemini37flash, styles: [O_CC, O_RESP], contextWindow: ONE_M, price: VERCEL_PRICES.gemini37flash },
          { id: "moonshotai/kimi-k3", label: "Kimi K3", ...MODEL_IDENTITIES.kimiK3, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: VERCEL_PRICES.kimiK3 },
          { id: "alibaba/qwen3.8-max", label: "Qwen3.8 Max", ...MODEL_IDENTITIES.qwen38max, styles: [A_MSG, O_CC, O_RESP], contextWindow: ONE_M, price: VERCEL_PRICES.qwen38max },
        ],
      },
    ],
  },
  {
    // docs/272 — OpenCode's OWN hosted inference, and the first service whose
    // native harness is neither Claude Code nor Codex.
    //
    // **The name is "OpenCode", not "OpenCode Zen"**: one account and one key
    // buy two products — Zen (pay-as-you-go credits) and Go ($10/month with
    // usage caps) — so the service row carries both and the billing modes are
    // where "Zen" and "Go" belong. A picker label naming only the metered
    // product would mislabel every subscription row.
    //
    // Both modes take the SAME pasted key (✅ vendor docs for both products,
    // and models.dev declares `OPENCODE_API_KEY` on both providers), which the
    // GLM precedent already supports — one secret, two `(service, mode)` rows,
    // each with its own `storageEnv` so the two credentials stay separable.
    // Asking for the same key twice is what req 7 calls wrong; until that is
    // built, the two names are how the two products stay addressable.
    id: "opencode",
    name: "OpenCode",
    modes: [
      {
        kind: "key",
        // OpenCode Zen. ✅ 2026-08-17, live against the real endpoints: every id
        // below answers `AuthError: Missing API key` on this base while a bogus
        // id answers `ModelError: Model … is not supported` — the registry check
        // runs BEFORE the auth check, so a no-key probe proves the id is served
        // here. Negative controls on the same run: `glm-5.3` and `qwen3.8-max`
        // are `ModelError` at Zen (they are Go-only), and `claude-opus-5` is
        // `ModelError` at Go.
        //
        // The two Anthropic-style bases differ by exactly `/v1` and that is not
        // a typo: Claude Code appends `/v1/messages` to `A_MSG`, while
        // chat-completions consumers append only `/chat/completions`, so that
        // base carries its own `/v1`. (The OpenCode adapter appends `/v1` to an
        // `A_MSG` base itself — docs/268.)
        endpoints: {
          [A_MSG]: "https://opencode.ai/zen",
          [O_CC]: "https://opencode.ai/zen/v1",
          // Same `/v1`-carrying base as chat-completions: Codex appends only
          // `/responses`. ✅ live, 2026-08-17.
          [O_RESP]: "https://opencode.ai/zen/v1",
        },
        credentials: [
          {
            via: "string",
            // ShipIt's own name for the Zen half of the key, NOT the vendor's
            // `OPENCODE_API_KEY`. Two reasons, and the second is why the row no
            // longer reads like DeepSeek's:
            //
            //  - The products need separable names anyway (`OPENCODE_GO_KEY`
            //    below), and a pair reading `OPENCODE_API_KEY` / `…_GO_KEY`
            //    would make the metered product look like the default one.
            //  - `OPENCODE_API_KEY` is a name the CLI auto-detects, so
            //    `HARNESS_CREDENTIAL_VARS.opencode` scrubs it from every
            //    OpenCode spawn. Storing under a scrubbed name worked — the
            //    scrub empties the SPAWN env while the adapter reads its own
            //    `process.env` and writes `OPENCODE_PROVIDER_API_KEY`
            //    (`opencode/adapter.ts`) — but it left one variable meaning two
            //    things. A distinct name keeps "what ShipIt stores" and "what
            //    the CLI must never see" apart.
            //
            // The cost is that exporting the documented vendor name no longer
            // gets a key adopted at boot (docs/252 req 20); adoption follows
            // ShipIt's name, which is what Settings → Secrets asks for.
            storageEnv: "OPENCODE_ZEN_API_KEY",
            // ✅ 2026-08-17, measured by invalid-key differential ("Invalid API
            // key" proves the header was read, "Missing API key" proves it was
            // ignored): `/messages` reads `x-api-key` ONLY and
            // `/chat/completions` reads `Authorization: Bearer` ONLY. Both match
            // the carrying harness's own default target, so no `targetOverride`
            // is needed anywhere.
            //
            // `carriers` is a LAUNCH GATE, not a wire fact — req 5 offers a
            // cross-harness pair "only after live verification shows it
            // works". OpenCode's own CLI is verified on both of this mode's
            // styles (real paid turns, 2026-08-17 §7). **Claude Code is
            // verified NOT to work** and that is why the gate stays: the turn
            // authenticates and routes correctly, then Zen refuses the request
            // body itself —
            //
            //   400 [invalid_request_error] context_management: Extra inputs
            //   are not permitted
            //
            // Claude Code puts a `context_management` block in its Messages
            // request, and Zen's upstream rejects any field outside the plain
            // Messages schema. It is a property of the CLI's request, not of a
            // model or a credential, so every Claude Code × Zen turn fails the
            // same way and no row-level change can rescue it. Removing this
            // line would offer the user a pair that 400s on its first turn.
            //
            // `carriers` is a LAUNCH GATE, not a wire fact — req 5 offers a
            // cross-harness pair "only after live verification shows it
            // works". All three pairs are now measured (2026-08-17, §7), and
            // they did not agree:
            //
            //  - **OpenCode** ✅ real paid turns on both of this mode's
            //    original styles.
            //  - **Codex** ✅ a real paid turn on `gpt-5.6-luna` over
            //    `openai-responses` — which is why the GPT/Grok rows below
            //    exist at all; without one, the join refused the pair on style
            //    before any gate was consulted.
            //  - **Claude Code** ❌ and that is why it is absent. The turn
            //    authenticates and routes correctly, then Zen refuses the
            //    request body itself:
            //
            //      400 [invalid_request_error] context_management: Extra
            //      inputs are not permitted
            //
            //    Claude Code puts a `context_management` block in its Messages
            //    request and Zen's upstream accepts nothing outside the plain
            //    schema. It is a property of the CLI's request, not of a
            //    model, a credential or a row, so every Claude Code × Zen turn
            //    fails identically and no row-level change can rescue it.
            //    Adding "claude" here would offer a pair that 400s on its
            //    first turn.
            carriers: ["opencode", "codex"],
          },
        ],
        retired: [],
        // The maintained subset is the **frontier coding set that overlaps
        // ShipIt's existing families** (docs/272 requirements, 2026-08-17
        // receipt) — Zen advertises 63 current models and most of them are
        // older generations, free-tier variants, or vendors ShipIt lists
        // nowhere else.
        //
        // **Style is per model and the vendor publishes it**, in the endpoint
        // table on `opencode.ai/docs/zen` and as `provider.npm` in models.dev
        // (the two agree for every row below, checked 2026-08-17):
        // `@ai-sdk/anthropic` → `/messages`, `@ai-sdk/openai` → `/responses`,
        // no entry → `/chat/completions`. It is NOT a free choice: ✅ live, the
        // gateway does not translate between styles — a chat-completions-upstream
        // model asked over another style reaches the upstream and fails with its
        // own 400.
        //
        // Deliberately NOT here, and each for a stated reason:
        //   - **Gemini**: served at `/v1/models/<id>:streamGenerateContent`
        //     with `@ai-sdk/google` — a fourth wire format ShipIt has no
        //     `ApiStyle` for.
        //   - **The free tier** (`*-free`, ~7 models): offerable as ordinary $0
        //     rows of this mode (2026-08-17 receipt) and left unauthored — each
        //     duplicates a paid row in a rate-limited form, and none is a
        //     frontier coding model, which is the subset rule this list follows.
        //     **Ox Alpha is here on req 8** (2026-08-21) — the human named it,
        //     which is a different warrant from the subset rule and not a
        //     narrowing of it. It would fail that rule: the rule keeps the set
        //     to models overlapping ShipIt's existing FAMILIES, and a stealth
        //     model overlaps none by construction. Two things are true of it
        //     that are not true of the other six, and neither is why it is
        //     here: it duplicates no paid row (nothing else on Zen serves it),
        //     and models.dev describes it as a "stealth reasoning model for
        //     coding, agentic tasks, and tool use" rather than a rate-limited
        //     copy. The rule is unamended and the other six stay out.
        models: [
          { id: "claude-opus-5", label: "Opus 5", ...MODEL_IDENTITIES.opus5, styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.opus5 },
          // Zen undercuts Anthropic's own rate here (2/10 against 3/15) — the
          // reason this service carries its own price constants at all.
          { id: "claude-sonnet-5", label: "Sonnet 5", ...MODEL_IDENTITIES.sonnet5, styles: [A_MSG], contextWindow: ONE_M, price: OPENCODE_ZEN_PRICES.sonnet5 },
          { id: "claude-fable-5", label: "Fable 5", ...MODEL_IDENTITIES.fable5, styles: [A_MSG], contextWindow: ONE_M, price: ANTHROPIC_PRICES.fable5 },
          // Zen spells Haiku `claude-haiku-4-5` where Anthropic's own row is
          // `haiku`; both reduce to one canonical model through
          // `MODEL_ID_ALIASES`.
          { id: "claude-haiku-4-5", label: "Haiku 4.5", ...MODEL_IDENTITIES.haiku45, styles: [A_MSG], contextWindow: { default: 200_000 }, price: ANTHROPIC_PRICES.haiku45 },
          { id: "kimi-k3", label: "Kimi K3", ...MODEL_IDENTITIES.kimiK3, styles: [O_CC], contextWindow: ONE_M, price: OPENCODE_ZEN_PRICES.kimiK3 },
          { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", ...MODEL_IDENTITIES.deepseekV4Flash, styles: [O_CC], contextWindow: ONE_M, price: OPENCODE_ZEN_PRICES.v4flash },
          { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", ...MODEL_IDENTITIES.deepseekV4Pro, styles: [O_CC], contextWindow: ONE_M, price: OPENCODE_ZEN_PRICES.v4pro },
          { id: "glm-5.2", label: "GLM-5.2", ...MODEL_IDENTITIES.glm52, styles: [O_CC], contextWindow: ONE_M, price: OPENCODE_ZEN_PRICES.glm52 },
          // Ox Alpha (req 8) — a stealth model with no maker named, hence its
          // own family, which `model-identity.ts` pairs with an explicit
          // "undisclosed" marker so the reviewer ranking stops short of
          // claiming a lineage difference it cannot establish. ✅ live
          // 2026-08-21, all four facts on this row measured rather than read:
          //
          //  - **Served here, under this id.** A completion on
          //    `/zen/v1/chat/completions` returns `model: "x-preview-f-free"`;
          //    the same call with a bogus id answers `ModelError: Model … is
          //    not supported`, which is the negative control the rest of this
          //    list uses.
          //  - **`O_CC` and nothing else**, per the vendor's endpoint table
          //    (`@ai-sdk/openai-compatible`) — and the gateway does not
          //    translate between styles, so a second style here would be a 400
          //    on every turn rather than a wider offer.
          //  - **1M context**, models.dev `limit.context`.
          //  - **`reasoningEfforts` is load-bearing on this row, not
          //    cosmetic.** `low`, `high` and `max` each returned a completion;
          //    `medium` — a level OpenCode's harness vocabulary offers and this
          //    row therefore has to remove — FAILED the request outright:
          //    `[1210] This model always engages in thinking and cannot be
          //    disabled; please use low, high, or max`. Same refusal Go's
          //    `glm-5.3` gives, and exactly the "vendor fact for the catalogue
          //    to carry" that `opencode-spawn-shaping.ts` says cannot live in
          //    its style table. Omit the field and every user who picks the
          //    harness default lands on a turn that cannot start.
          //
          // One live fact deliberately NOT modelled: this id answers with **no
          // credential at all** (the anonymous free tier, rate-limited per
          // caller). It stays a row of the key mode because docs/272 req 4's
          // receipt puts the credential-less tier out of scope — ShipIt offers
          // the ways an OpenCode *account* can be used, and a Zen key is what
          // makes this an account's model rather than an anonymous request.
          { id: "x-preview-f-free", label: "Ox Alpha Free", ...MODEL_IDENTITIES.oxAlpha, styles: [O_CC], contextWindow: ONE_M, price: OPENCODE_ZEN_PRICES.oxAlpha, reasoningEfforts: ["max", "high", "low"] },
          // The `openai-responses` rows. Authored after the first pass on the
          // user's instruction, because without one Codex could not be paired
          // with this service at all: it speaks only that style, so the join
          // refused the pair before any credential or gate was consulted.
          //
          // Windows follow the catalogue's existing GPT and Grok rows
          // (`CODEX_WINDOW`, `HALF_M`) rather than models.dev's larger figures,
          // so one canonical model does not claim two different sizes
          // depending on which service the user picked.
          { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", ...MODEL_IDENTITIES.gpt56sol, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENCODE_ZEN_PRICES.gpt56sol },
          { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", ...MODEL_IDENTITIES.gpt56terra, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENCODE_ZEN_PRICES.gpt56terra },
          { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", ...MODEL_IDENTITIES.gpt56luna, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENCODE_ZEN_PRICES.gpt56luna },
          { id: "grok-4.6", label: "Grok 4.6", ...MODEL_IDENTITIES.grok46, styles: [O_RESP], contextWindow: HALF_M, price: OPENCODE_ZEN_PRICES.grok46 },
        ],
      },
      {
        kind: "sub",
        // OpenCode Go — the $10/month plan, authenticated by the same pasted
        // key as Zen (sub-via-string, the GLM coding-plan shape). Go entitlement
        // is account-side in the console; there is no separate Go key, and only
        // one member per workspace can subscribe ✅ vendor docs.
        //
        // Quota: declared, unread — docs/272 req 6, the human's decision on the
        // two honest options. Go's caps are dollar-denominated (5h $12, weekly
        // $30, monthly $60 ✅ vendor docs) and there is no per-key usage API to
        // read them from (plan.md §8), so ShipIt shows no remaining-quota figure
        // and reacts to the service's own 429 like any other subscription.
        quota: "opencode-go-usage",
        endpoints: {
          [O_CC]: "https://opencode.ai/zen/go/v1",
          [O_RESP]: "https://opencode.ai/zen/go/v1",
        },
        credentials: [
          {
            via: "string",
            // Its own name even though the SECRET is the same pasted key as
            // Zen's: one `storageEnv` per `(service, mode)` is the catalogue
            // invariant, and it is what keeps the two products two credential
            // rows in Settings rather than Go hiding behind a stored Zen key.
            // The GLM precedent again — `ZAI_CODING_PLAN_KEY` / `ZAI_API_KEY`.
            storageEnv: "OPENCODE_GO_KEY",
            // Same wire facts as the Zen credential above, and the same gate
            // settled by its own measurement: ✅ a real Codex turn on Go's
            // `gpt-5.6-luna`, accounted as an INCLUDED turn (subscription) —
            // so Codex reaches this product on the plan, not only on Zen
            // credits. Claude Code is absent for the reason the Zen credential
            // records, and cannot reach Go anyway: it speaks only
            // `anthropic-messages`, which no Go model declares.
            carriers: ["opencode", "codex"],
          },
        ],
        retired: [],
        // Go's published list is 20 models of open-weight coding families; these
        // are the ones overlapping ShipIt's existing identities. Every id ✅
        // 2026-08-17 against the `/zen/go` base by the same registry probe.
        //
        // Not here: MiMo/MiniMax/Hy3 (families ShipIt lists nowhere else), and
        // **Qwen3.8 Max, which the two sources
        // disagree about**: the vendor's Go endpoint table publishes it under
        // `/messages` (`@ai-sdk/anthropic`) while models.dev still has it as
        // chat-completions. Declaring the wrong one is a 400 on every turn, and
        // the gateway does not translate, so it waits for a real key to settle
        // it — the first item of docs/272 plan.md §7.
        models: [
          { id: "glm-5.3", label: "GLM-5.3", ...MODEL_IDENTITIES.glm53, styles: [O_CC], contextWindow: ONE_M, price: OPENCODE_GO_PRICES.glm5x },
          { id: "glm-5.2", label: "GLM-5.2", ...MODEL_IDENTITIES.glm52, styles: [O_CC], contextWindow: ONE_M, price: OPENCODE_GO_PRICES.glm5x },
          { id: "kimi-k3", label: "Kimi K3", ...MODEL_IDENTITIES.kimiK3, styles: [O_CC], contextWindow: ONE_M, price: OPENCODE_GO_PRICES.kimiK3 },
          { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", ...MODEL_IDENTITIES.deepseekV4Pro, styles: [O_CC], contextWindow: ONE_M, price: OPENCODE_GO_PRICES.v4pro },
          { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", ...MODEL_IDENTITIES.deepseekV4Flash, styles: [O_CC], contextWindow: ONE_M, price: OPENCODE_GO_PRICES.v4flash },
          // Go's one `openai-responses` model, and the only way Codex can run
          // on the subscription rather than on Zen credits. ✅ live registry
          // probe on `/zen/go/v1/responses`, with `gpt-5.6-sol` answering
          // `ModelError` on the same route as the negative control — Go serves
          // Luna and not the rest of the family.
          //
          // Go also serves `grok-4.5` here, left unauthored: it is superseded
          // by the 4.6 the rest of the catalogue carries, and Go does not serve
          // 4.6, so adding it would introduce a canonical model this catalogue
          // names nowhere else.
          { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", ...MODEL_IDENTITIES.gpt56luna, styles: [O_RESP], contextWindow: CODEX_WINDOW, price: OPENCODE_GO_PRICES.gpt56luna },
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
