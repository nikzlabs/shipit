/**
 * docs/261 phase 0 — **who a model is**, declared once for the whole catalogue.
 *
 * docs/261 req 4 asks ShipIt to review work with the reviewer *furthest* from
 * the implementer, and fixes the model **family** as the first axis. Answering
 * that needs two facts the catalogue could not state, and they are two facts
 * rather than one:
 *
 *  - **identity** — `anthropic/claude-opus-5` at a gateway and `claude-opus-5`
 *    at Anthropic are the SAME model. So are `glm-5.2[1m]` and `glm-5.2`, which
 *    differ only by the suffix Claude Code consumes to select the long-context
 *    variant.
 *  - **lineage** — Opus and Sonnet are different models that share their
 *    training. DeepSeek and GLM do not.
 *
 * One field cannot answer both: Opus and Sonnet are one family and two models,
 * while the two Opus spellings are one model under two ids. Neither fact is
 * derivable — not from the service (docs/252 deliberately lists one model under
 * a vendor AND under a gateway) and not from the id (identical models spell
 * differently; one model spells differently per billing mode). Authoring them is
 * the only honest source.
 *
 * **Why this file exists rather than two strings on each row.** A free-form
 * string retyped per offering makes a typo compile, pass, and cause ShipIt to
 * call a same-model review independent — the single failure this whole feature
 * exists to prevent. So each canonical model is declared here ONCE, with its
 * family, and a catalogue row REFERENCES the declaration:
 *
 * ```ts
 * { id: "anthropic/claude-opus-5", label: "Opus 5", ...MODEL_IDENTITIES.opus5, … }
 * ```
 *
 * The spread is what makes a mismatched pair unwritable rather than merely
 * caught: there is no way to spell the two fields apart. Both are additionally
 * typed as literal unions derived from the table below, so a typo is a compile
 * error, and `catalogue.test.ts` asserts that every pair reaching a row is one
 * this table declares.
 *
 * **Node-free by construction**, like the rest of this tree — the client imports
 * it.
 */

/**
 * The training lineages the catalogue distinguishes, at **vendor** granularity.
 *
 * Vendor and not generation, deliberately. Req 4 wants the axis that "carries
 * the training a second opinion is trying not to share", and Haiku 4.5 sitting
 * beside Opus 5 shares far more with it than either shares with GPT-5 — so a
 * generation-scoped family would call an Anthropic pair distant on a difference
 * that changes nothing. A vendor that genuinely retrains from scratch gets a new
 * family here; a new generation of an existing line does not.
 *
 * A family is NOT a service (req 4 says so outright): a gateway serves another
 * vendor's models, so `openrouter` and `anthropic` are two services offering one
 * family.
 */
export const MODEL_FAMILY_IDS = [
  "claude",
  "gpt",
  "deepseek",
  "glm",
  "gemini",
  "grok",
  "kimi",
  "qwen",
] as const;

export type ModelFamily = (typeof MODEL_FAMILY_IDS)[number];

/** One canonical model: what it is, and what it shares its training with. */
export interface ModelIdentity {
  /**
   * Identity. Two offerings carrying the same key **are the same model**,
   * whatever their ids or services — so a review by one is not a second opinion
   * on the other. Collapses gateway prefixes (`anthropic/claude-opus-5`), mode
   * suffixes (`glm-5.2[1m]`) and vendor aliases.
   */
  canonicalModelKey: string;
  /** Lineage. What this model shares its training with (see {@link MODEL_FAMILY_IDS}). */
  family: ModelFamily;
}

/** Declares one canonical model. Only used to build {@link MODEL_IDENTITIES}. */
function identity<K extends string, F extends ModelFamily>(
  canonicalModelKey: K,
  family: F,
): { readonly canonicalModelKey: K; readonly family: F } {
  return { canonicalModelKey, family } as const;
}

/**
 * Every canonical model the catalogue offers, declared once.
 *
 * The key is a spelling-free handle for the row author; `canonicalModelKey` is
 * the identity itself. They usually match the vendor's own direct id, which is
 * a convenience and not a rule — a gateway-only model would still get an entry
 * here, and a model whose direct id later changes keeps its key.
 *
 * Adding a service that offers an existing model adds NO entry here: the new row
 * references the entry that already exists, which is the whole point.
 */
export const MODEL_IDENTITIES = {
  // Anthropic's line. Fable and Haiku are siblings of Opus and Sonnet — one
  // family, four models.
  opus5: identity("claude-opus-5", "claude"),
  sonnet5: identity("claude-sonnet-5", "claude"),
  haiku45: identity("claude-haiku-4.5", "claude"),
  fable5: identity("claude-fable-5", "claude"),

  // OpenAI's line. The `gpt-5.6-*` variants are distinct models of one family,
  // as are the older 5.2–5.5 rows.
  gpt56sol: identity("gpt-5.6-sol", "gpt"),
  gpt56terra: identity("gpt-5.6-terra", "gpt"),
  gpt56luna: identity("gpt-5.6-luna", "gpt"),
  gpt55: identity("gpt-5.5", "gpt"),
  gpt54: identity("gpt-5.4", "gpt"),
  gpt54mini: identity("gpt-5.4-mini", "gpt"),
  gpt53codex: identity("gpt-5.3-codex", "gpt"),
  gpt52: identity("gpt-5.2", "gpt"),

  deepseekV4Flash: identity("deepseek-v4-flash", "deepseek"),
  deepseekV4Pro: identity("deepseek-v4-pro", "deepseek"),

  // One canonical model under three ids: `glm-5.2[1m]` on the coding plan,
  // `glm-5.2` on Z.ai's own key, `z-ai/glm-5.2` at OpenRouter. This is the pair
  // that proves the field is not derivable from the id.
  glm52: identity("glm-5.2", "glm"),
  // TEMPORARY PROBE IDENTITY — reverted before this branch ships. See the probe
  // row in services.ts.
  glm53probe: identity("glm-5.3", "glm"),
  // TEMPORARY NEGATIVE CONTROL — a model id that cannot exist. If a turn on this
  // id SUCCEEDS, the service is ignoring the requested model and falling back to
  // a default, which would make the GLM-5.3 pass prove nothing about the id.
  glm99probe: identity("glm-9.9-nonexistent", "glm"),

  // Gateway-only models (2026-08-16). ShipIt holds no direct credential for
  // Google, xAI, Moonshot or Alibaba, so each of these is reachable ONLY through
  // OpenRouter and Vercel — which is exactly the case `canonicalModelKey` was
  // built for, because the two gateways namespace the same model differently
  // (`x-ai/grok-4.6` vs `xai/grok-4.6`, `qwen/qwen3.8-max` vs
  // `alibaba/qwen3.8-max`). The prefix is dropped by
  // `normalizeModelIdForIdentity`, so both spellings reduce to the key below and
  // ShipIt knows a review by one is not a second opinion on the other.
  gemini37flash: identity("gemini-3.7-flash", "gemini"),
  grok46: identity("grok-4.6", "grok"),
  kimiK3: identity("kimi-k3", "kimi"),
  qwen38max: identity("qwen3.8-max", "qwen"),
} as const;

/**
 * Row ids whose spelling does NOT reduce to their canonical key, and the key
 * each one really is.
 *
 * {@link normalizeModelIdForIdentity} handles the two mechanical differences a
 * catalogue row can carry — a gateway's `provider/` prefix and Claude Code's
 * `[1m]` suffix — which covers almost every alias here. What it cannot do is
 * recognise a vendor's own short name for a model. Anthropic's `haiku` is the
 * only such row today.
 *
 * **This table is the human confirmation that two differently-named things are
 * one model**, and it exists because the alternative was an invariant that
 * caught nothing: a row can spread the *wrong existing* declaration —
 * `MODEL_IDENTITIES.gpt56terra` on the GPT-5.6 Sol row — and every generic
 * consistency check still passes, because the pair is valid and agrees with
 * itself. Cross-backend review found exactly that hole. `catalogue.test.ts`
 * closes it by tying each row's id to its key, with this as the only escape.
 *
 * So: an entry here is a claim a reviewer should check, not boilerplate.
 */
export const MODEL_ID_ALIASES: Record<string, string> = {
  // Anthropic's own short id for Haiku 4.5, which the picker has always used.
  haiku: "claude-haiku-4.5",
};

/**
 * A row id reduced to the spelling its canonical key would use: gateway
 * namespace dropped, Claude Code's long-context suffix dropped.
 *
 * Both are mechanical restatements of one model rather than different models —
 * `anthropic/claude-opus-5` is Anthropic's Opus through a gateway, and
 * `glm-5.2[1m]` is GLM-5.2 with the CLI told to use its full window (the CLI
 * consumes the suffix, so the service never sees it).
 */
export function normalizeModelIdForIdentity(id: string): string {
  const withoutNamespace = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return withoutNamespace.replace(/\[[^\]]*\]$/, "");
}

/** Every canonical key the catalogue declares — a literal union, so a typo cannot compile. */
export type CanonicalModelKey =
  (typeof MODEL_IDENTITIES)[keyof typeof MODEL_IDENTITIES]["canonicalModelKey"];

/**
 * The declared identities keyed by their own `canonicalModelKey`.
 *
 * What `catalogue.test.ts` checks a row's authored pair against: a row that
 * spells the two fields by hand (rather than spreading a declaration) and gets
 * them out of step fails there.
 */
export const MODEL_IDENTITY_BY_KEY: Record<string, ModelIdentity> = Object.fromEntries(
  Object.values(MODEL_IDENTITIES).map((entry) => [entry.canonicalModelKey, entry]),
);

/** True when two selections resolve to the same model — see {@link ModelIdentity}. */
export function sameCanonicalModel(a: ModelIdentity | undefined, b: ModelIdentity | undefined): boolean {
  if (!a || !b) return false;
  return a.canonicalModelKey === b.canonicalModelKey;
}

/** True when two selections share a training lineage — req 4's first axis. */
export function sameModelFamily(a: ModelIdentity | undefined, b: ModelIdentity | undefined): boolean {
  if (!a || !b) return false;
  return a.family === b.family;
}
