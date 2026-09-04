/**
 * planning#460 — **can this model see an image**, declared once per canonical
 * model for the whole catalogue.
 *
 * ## Why this is not a `ModelDef` field
 *
 * `reasoningEfforts` is the recent precedent for a per-model capability and it
 * lives on the ROW, correctly: the fact it carries genuinely differs between two
 * rows of the same model (xAI's subscription `grok-4.6` offers `xhigh`, its
 * key-billed twin offers nothing at all). That is the test for the row — *do two
 * offerings of one model disagree?*
 *
 * Vision does not. It is a property of the weights, so every offering of one
 * model answers the same way, and the catalogue already has a place for a fact
 * that is true of the model rather than of the offering: `canonicalModelKey`
 * (`model-identity.ts`), whose whole design rule is that *"adding a service that
 * offers an existing model adds NO entry here"*. `deepseek-v4-flash` appears in
 * five rows across four services; on a `ModelDef` field its verdict would be
 * authored five times, and the fifth is where the typo lands.
 *
 * **If a service is ever MEASURED to differ** (a gateway whose translation drops
 * the image part while the upstream model sees fine), that is the day a
 * per-row override earns its place on `ModelDef`, keyed off a probe. Not before,
 * and not from a guess.
 *
 * ## Where these verdicts came from
 *
 * Read on **2026-08-23** from two independent public model endpoints, neither
 * authenticated:
 *
 *   - `GET https://openrouter.ai/api/v1/models` → `architecture.input_modalities`
 *   - `GET https://ai-gateway.vercel.sh/v1/models` → `modalities.input`
 *
 * The same two endpoints this catalogue's gateway prices were authored from
 * (`services.ts`, the 2026-08-16 correction). models.dev — OpenCode's own
 * source, and the obvious third — is not resolvable from a session container.
 *
 * **The two agree on every model both carry** — each of the four text-only models
 * below is text-only at BOTH, over different translation layers.
 *
 * **What that does NOT establish is service invariance.** These are two
 * gateways; they say nothing directly about DeepSeek's own endpoint, Z.ai's,
 * OpenCode Zen's or Go's, and a reviewer was right to say so. What makes the gap
 * tolerable is the DIRECTION of the risk. The only verdict that can hurt anyone
 * is a `"no"`, and a `"no"` is wrong only if the MODEL can in fact see — a
 * service cannot add vision to weights that lack it. So a wrong refusal needs
 * two independent sources to be wrong about the model itself, not merely
 * unrepresentative of a third service. The other direction (a service that
 * cannot carry an image for a model that can) is a real possibility and is
 * exactly what the per-row override above is reserved for.
 *
 * One model has no verdict from either, and it is marked so rather than guessed
 * — see {@link MODEL_VISION}.
 */

import type { CanonicalModelKey } from "./model-identity.js";

/**
 * Whether a model accepts image input.
 *
 * Three states rather than a boolean, because an **unknown must not read as a
 * known-false**: the two resolve differently, and getting that backwards is the
 * bug planning#458 shipped and planning#460 exists to unwind.
 *
 *   - `"yes"` / `"unverified"` — ShipIt hands the image over. A model that turns
 *     out not to see one produces a visible failure (a service rejection, or an
 *     agent saying it cannot see the picture), which is recoverable.
 *   - `"no"` — ShipIt refuses the attachment up front and says which model
 *     cannot read it. Only this value changes behaviour, so only this value
 *     needs a verdict strong enough to act on.
 *
 * `"unverified"` is therefore the SAFE state and the default posture, not a
 * placeholder to be cleared: it preserves exactly what shipped in planning#458
 * for every model nobody has checked.
 */
export type VisionSupport = "yes" | "no" | "unverified";

/**
 * Every canonical model's verdict.
 *
 * `Record<CanonicalModelKey, …>` is exhaustive by construction: adding an entry
 * to `MODEL_IDENTITIES` without a verdict here is a compile error, which is why
 * this needs no companion "every model is covered" test.
 */
export const MODEL_VISION: Record<CanonicalModelKey, VisionSupport> = {
  // Anthropic's line — image on both sources.
  "claude-opus-5": "yes",
  "claude-sonnet-5": "yes",
  "claude-haiku-4.5": "yes",
  "claude-fable-5": "yes",
  "claude-fable-5.1": "yes",

  // OpenAI's line — image on both sources for every row that a gateway serves.
  // GPT-6 Astra is verified from OpenAI's model page and Codex 0.153.2's
  // embedded model metadata (2026-09-04); gateway coverage is not needed for
  // this first-party row.
  "gpt-6-astra": "yes",
  "gpt-5.6-sol": "yes",
  "gpt-5.6-terra": "yes",
  "gpt-5.6-luna": "yes",
  "gpt-5.5": "yes",
  "gpt-5.4": "yes",
  "gpt-5.4-mini": "yes",
  "gpt-5.3-codex": "yes",
  // The one model NEITHER source carries, and for a reason that will not expire:
  // Spark is a ChatGPT Pro-only research preview with API access marked false
  // (`services.ts`, `OPENAI_PRICES.gpt53codexSparkProvisional`), so no gateway
  // can front it and no public endpoint publishes its modalities. Every
  // GPT-5.x-codex sibling on both sources takes image, which is a good reason to
  // EXPECT `"yes"` and not a measurement of this model — so it stays unverified.
  // Costs nothing today: Spark is declared only under OpenAI's subscription
  // mode, which only Codex can carry, and Codex's image path is verified working
  // (PR #2518).
  "gpt-5.3-codex-spark": "unverified",
  "gpt-5.2": "yes",

  // ---- The four that actually gate anything -------------------------------
  // Text-only on BOTH sources, independently. These are the models an image
  // attachment is now refused for, and the reason the mechanism exists:
  // `deepseek-v4-flash` through OpenCode is the exact case planning#460 names.
  "deepseek-v4-flash": "no",
  "deepseek-v4-pro": "no",
  "glm-5.2": "no",
  "glm-5.3": "no",
  // -------------------------------------------------------------------------

  "gemini-3.7-flash": "yes",

  "grok-4.6": "yes",
  "grok-4.5": "yes",
  "grok-4.3": "yes",
  // Vercel carries the reasoning/non-reasoning split verbatim
  // (`spacexai/grok-4.20-reasoning`, `…-non-reasoning`) and reports image for
  // both; OpenRouter lists the line unsplit as `x-ai/grok-4.20`, also image. So
  // both halves are measured, and the second source corroborates the line.
  "grok-4.20-0309-reasoning": "yes",
  "grok-4.20-0309-non-reasoning": "yes",

  "kimi-k3": "yes",
  "qwen3.8-max": "yes",
  // Single-sourced (OpenRouter only; Vercel does not carry it). A stealth model
  // is exactly where a source could be wrong — but the verdict is `"yes"`, which
  // changes no behaviour, so a wrong `"yes"` here costs the same visible failure
  // an `"unverified"` would.
  "ox-alpha": "yes",
};
