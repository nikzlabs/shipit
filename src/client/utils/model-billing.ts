/**
 * Per-model billing metadata for the model picker.
 *
 * Most models the picker offers are covered by the user's Claude subscription
 * (Pro / Max / Team / Enterprise) and don't bill per token. Some are not —
 * surfacing that in the picker keeps a developer from unknowingly racking up
 * token charges while trying to hit a target.
 *
 * Fable 5 is the first such model. Anthropic included it on subscription plans
 * only through **June 22, 2026** (a promotional window); from June 23 it
 * switches to metered usage credits billed at API rates — $10 / $50 per
 * million input / output tokens, roughly 2× Opus 4.8. The badge is therefore
 * date-sensitive: an informational "free until" pill during the window, a
 * warning "metered" pill afterward. `now` is injectable so the transition is
 * testable without faking the clock.
 *
 * Consumed by `ModelAgentSelector` (the picker rows). Keyed by the same model
 * ids as `CLAUDE_MODELS` — keep this in sync when a non-subscription model is
 * added.
 */

export type ModelBillingTone = "included" | "metered";

export interface ModelBilling {
  /** Short pill text shown next to the model name in the picker. */
  badge: string;
  /** Drives the pill color: `included` = info, `metered` = warning. */
  tone: ModelBillingTone;
  /** Full explanation surfaced as the row's title tooltip. */
  tooltip: string;
}

/**
 * UTC instant when Fable 5 leaves subscription plans and becomes metered.
 * `Date.UTC` month is 0-based, so 5 = June → 2026-06-23T00:00:00Z. Through
 * June 22 inclusive it's still plan-included; the 23rd flips it to metered.
 */
const FABLE_METERED_FROM = Date.UTC(2026, 5, 23);

const FABLE_PRICING = "$10 / $50 per million input / output tokens, roughly 2× Opus 4.8";

export function getModelBilling(modelId: string, now: Date = new Date()): ModelBilling | undefined {
  if (modelId !== "claude-fable-5") return undefined;

  if (now.getTime() >= FABLE_METERED_FROM) {
    return {
      badge: "Metered",
      tone: "metered",
      tooltip: `Not included in your subscription. Fable 5 is billed per token via usage credits at API rates — ${FABLE_PRICING}.`,
    };
  }

  return {
    // Short pill — "Included" (not "Free": it draws from the subscription, it
    // isn't zero-cost). The "through June 22" detail lives in the tooltip.
    badge: "Included",
    tone: "included",
    tooltip: `Included in your Pro / Max / Team / Enterprise plan through June 22, 2026. From June 23 it switches to metered usage credits at API rates — ${FABLE_PRICING}.`,
  };
}
