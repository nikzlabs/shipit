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
  // A **stealth** model's lineage, which is a family precisely because nobody
  // outside the vendor knows what it is. OpenCode publishes Ox Alpha with no
  // maker named, so every alternative to its own family is a claim this
  // repository cannot make: filing it under an existing vendor asserts a
  // lineage nobody disclosed, and reusing another family's handle would make
  // ShipIt refuse a review pairing on a guess.
  //
  // It is NOT a claim of distance either, and that distinction is the whole of
  // {@link UNDISCLOSED_LINEAGE} below: a family of its own makes every
  // comparison report "different family", which is the ideal reviewer tier
  // (docs/261 req 4) awarded on something nobody established. So `ox` is
  // declared here AND named as undisclosed, and the ranking degrades what it
  // *claims* rather than what it *chooses*.
  "ox",
] as const;

/**
 * Families that stand for "the vendor has not said who trained this", not for a
 * lineage anyone knows.
 *
 * `family` answers "what does this share its training with", and a stealth
 * release has no answer. The catalogue still has to write one — the field is
 * required, and every alternative spelling asserts more than the vendor did —
 * so the honest shape is a family of its own PLUS this set, which is how the
 * ranking can tell a decided difference from an undecided one.
 *
 * What it changes: nothing about which reviewer is chosen. `sameModelFamily`
 * still reports `false` against every disclosed family, so the ORDERING is
 * untouched. What degrades is the `tierBasis` a selection reports — the field
 * `reviewer-model.ts` added precisely so that a tier of 1 is never read as "a
 * different family was established" when it wasn't. Without this, a stealth
 * model is the one identity that is *present* and still undecidable, and it
 * would sail past a check written for identities that are *absent*.
 *
 * **Why the TIER is deliberately left alone**, which review has now asked twice.
 * The objection is real on its face: an undisclosed candidate can outrank a
 * candidate whose different family IS established, so ShipIt may prefer the
 * unproven second opinion. But `reviewer-model.ts` already answers this for the
 * identical epistemic state — an identity it cannot resolve at all, where
 * `sameCanonicalModel` and `sameModelFamily` both report `false` and the pair
 * lands on the same top rung, documented as failing "toward *using* a reviewer
 * rather than refusing one". A stealth model is that state with a row attached.
 * Ranking it below a model ShipIt cannot identify at all would mean knowing more
 * about a model made it a worse reviewer, and changing BOTH is a change to
 * docs/261's ranking, not to this row. So the claim degrades and the tier does
 * not.
 *
 * Note the residual: two undisclosed models would compare as one family and
 * rank as closer than they might be. That is the conservative direction — it
 * refuses to claim independence rather than inventing it — and there is one
 * such model today.
 *
 * Typed by {@link ModelFamily} and not by `string`, so a family named here that
 * the catalogue does not declare is a compile error rather than a safeguard that
 * silently matches nothing.
 */
export const UNDISCLOSED_LINEAGE: ReadonlySet<ModelFamily> = new Set<ModelFamily>(["ox"]);

/** True when this identity's family stands for an undisclosed lineage. */
export function lineageIsUndisclosed(identity: ModelIdentity | undefined): boolean {
  return identity !== undefined && UNDISCLOSED_LINEAGE.has(identity.family);
}

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
  gpt53codexSpark: identity("gpt-5.3-codex-spark", "gpt"),
  gpt52: identity("gpt-5.2", "gpt"),

  deepseekV4Flash: identity("deepseek-v4-flash", "deepseek"),
  deepseekV4Pro: identity("deepseek-v4-pro", "deepseek"),

  // One canonical model under three ids: `glm-5.2[1m]` on the coding plan,
  // `glm-5.2` on Z.ai's own key, `z-ai/glm-5.2` at OpenRouter. This is the pair
  // that proves the field is not derivable from the id.
  glm52: identity("glm-5.2", "glm"),
  // GLM-5.3 (2026-08-14) is a post-training-only release over GLM-5.2 — same base
  // model, different model. `glm` family (shared training, which is literally
  // true here), distinct canonical key: a GLM-5.3 review is not a second opinion
  // on GLM-5.2's work, and vice versa.
  glm53: identity("glm-5.3", "glm"),

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
  // docs/274 — xAI as a first-party service (the `grok` harness's native one)
  // adds three more of its own models. The 4.20 pair is ONE model under two
  // ids only in the sense that the vendor ships them as a line; they are
  // separately-billed catalog entries whose reasoning behaviour differs, so
  // they are two canonical models, not one with a suffix. That matters for
  // docs/261: a review by `-reasoning` of work done by `-non-reasoning` is a
  // second opinion from the same *family* but not the same model.
  grok43: identity("grok-4.3", "grok"),
  // planning#435 — subscription-only. Its own canonical key rather than a
  // spelling of 4.6: they are different models on the same training lineage, so
  // a 4.5 review of 4.6's work IS a second opinion (docs/261 req 4) and the
  // reviewer ranking must be able to say so.
  grok45: identity("grok-4.5", "grok"),
  grok420Reasoning: identity("grok-4.20-0309-reasoning", "grok"),
  grok420NonReasoning: identity("grok-4.20-0309-non-reasoning", "grok"),
  kimiK3: identity("kimi-k3", "kimi"),
  qwen38max: identity("qwen3.8-max", "qwen"),

  // OpenCode Zen's stealth model, served ONLY there (2026-08-20), and keyed by
  // its wire id rather than by the vendor's product name "Ox Alpha Free".
  //
  // The readable `ox-alpha` was tried first and is wrong here, for the reason
  // this file gives itself: an alias entry is "a claim a reviewer should check",
  // and the only claim available today is that the display name and the wire id
  // name one model. Dropping `preview` and `free` from the key would assert
  // something further — that a model leaving stealth under a new id is still
  // THIS model — which no source establishes and nothing yet needs. When the id
  // does change, that is the moment to decide it, with facts.
  oxAlpha: identity("x-preview-f-free", "ox"),
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
  // OpenCode Zen spells the same model with hyphens where Anthropic spells it
  // with a dot (`claude-haiku-4-5`). A punctuation difference in one id, not a
  // second model: Zen is a gateway serving Anthropic's own Haiku 4.5, at
  // Anthropic's own rate.
  "claude-haiku-4-5": "claude-haiku-4.5",
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
