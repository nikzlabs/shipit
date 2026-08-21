/**
 * docs/252 phase 3 (req 16) — who billed a turn, and what it cost.
 *
 * Phase 3a widened the usage ROW (`usage.ts`): `service_id`, `billing_mode`, the
 * four rate columns under an all-or-nothing `CHECK`, and a `costSource`
 * discriminator. This is the other half — the producers' rule, in one place so
 * the two writers (a primary turn, a sub-agent consult) cannot disagree.
 *
 * ## `cost_usd` has exactly one meaning from here on
 *
 * **Money that left the account for this turn.** Not "what the harness said",
 * which is a figure produced by a CLI that was never told which vendor it is
 * talking to; not plan usage valued at API rates, which is a comparison and
 * never money spent (req 16).
 *
 * The column decides the source, keyed on **billing mode** (`catalogue.md`,
 * *Pricing*):
 *
 * | Row | `cost_usd` |
 * |---|---|
 * | `sub` | **zero.** Nothing was billed. Its at-API-rates value is recomputed at read time from the persisted rates, and is phase 6's to display. |
 * | `key` on the harness's own vendor, harness reported a figure | that figure, still cumulative — the one cell where an existing accuracy claim holds (`usage.ts`, docs/013), so the design is not entitled to replace it with a four-rate approximation. |
 * | `key`, anything else | the persisted rates × this turn's tokens, per-turn. |
 *
 * Earlier drafts keyed the exception on the *service* instead, which reaches all
 * four (native × mode) cells and only one of them is a record of real money — it
 * preserved a dollar figure for a subscription turn where nothing was billed,
 * and preserved Codex's `$0` as though metered OpenAI usage were free. Keyed on
 * the mode it lands on exactly one cell. Do not re-derive the service-keyed
 * version.
 *
 * ## The visible consequence, stated rather than discovered
 *
 * A Claude subscription session's dial and usage modal stop showing a dollar
 * figure they show today, because that figure was never money. That is req 16's
 * decision; **what those surfaces show instead** is settled in
 * `requirements.md` (the at-API-rates estimate, labelled) and is phase 6's to
 * build.
 */

import type { AgentId } from "../shared/types.js";
import type { TurnAttribution, TurnCostSource } from "./usage.js";
import {
  getModel,
  nativeServiceForHarness,
  type ModelSelection,
} from "../shared/catalogue/index.js";
import type { ModelPrice } from "../shared/catalogue/types.js";

/** The token counts a cost is computed from. All optional; absent counts as zero. */
export interface TurnTokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * The attribution to persist with a turn, or `undefined` when the selection
 * names no catalogue row — which writes a `legacy` row rather than a guess.
 *
 * The rates come from the catalogue **now** and are persisted with the row on
 * purpose: a later price edit must not silently restate what a past turn cost,
 * and a retired model has no live price to look up at all.
 */
export function turnAttributionFor(selection: ModelSelection | undefined): TurnAttribution | undefined {
  if (!selection) return undefined;
  const model = getModel(selection);
  if (!model) return undefined;
  return {
    serviceId: selection.serviceId,
    billingMode: selection.billingMode,
    rates: model.price,
  };
}

/** USD for these tokens at these rates. Rates are per MILLION tokens. */
export function costFromRates(rates: ModelPrice, tokens: TurnTokens): number {
  const usd =
    (tokens.input ?? 0) * rates.input
    + (tokens.output ?? 0) * rates.output
    + (tokens.cacheRead ?? 0) * rates.cacheRead
    + (tokens.cacheWrite ?? 0) * rates.cacheWrite;
  return usd / 1_000_000;
}

/**
 * What to store in `cost_usd`, and whether it still needs the
 * cumulative-to-delta conversion.
 *
 * `reportedCostUsd` is the harness's own figure, or `undefined` when it reported
 * none — which is the honest input, not a zero. Codex reports no dollar figure
 * at all, so collapsing "reported nothing" into "cost nothing" is what made
 * every metered OpenAI turn look free.
 *
 * With no attribution this reproduces today's behaviour exactly: the harness
 * figure, treated as cumulative. That is the `legacy` row, and it is what a
 * session with no catalogue-resolvable selection keeps getting.
 */
export function resolveTurnCost(args: {
  harnessId: AgentId;
  attribution: TurnAttribution | undefined;
  reportedCostUsd: number | undefined;
  tokens: TurnTokens;
  /** Default `cumulative` — a harness's running total. A one-shot consult passes `per-turn`. */
  reportedCostSource?: TurnCostSource;
}): { costUsd: number; costSource: TurnCostSource } {
  const { harnessId, attribution, reportedCostUsd, tokens } = args;
  const reportedSource = args.reportedCostSource ?? "cumulative";
  if (!attribution) {
    return { costUsd: reportedCostUsd ?? 0, costSource: reportedSource };
  }
  // A subscription turn spent no money. The rates are still persisted with the
  // row — they are what req 16's "would have cost" comparison recomputes from.
  if (attribution.billingMode === "sub") {
    return { costUsd: 0, costSource: "per-turn" };
  }
  const isNativeService = nativeServiceForHarness(harnessId) === attribution.serviceId;
  if (isNativeService && reportedCostUsd !== undefined) {
    return { costUsd: reportedCostUsd, costSource: reportedSource };
  }
  return { costUsd: costFromRates(attribution.rates, tokens), costSource: "per-turn" };
}

/** The session's persisted triple, when it holds a complete one. */
export function selectionOf(session: {
  model?: string;
  serviceId?: string;
  billingMode?: ModelSelection["billingMode"];
} | undefined): ModelSelection | undefined {
  if (!session?.model || !session.serviceId || !session.billingMode) return undefined;
  return {
    serviceId: session.serviceId,
    billingMode: session.billingMode,
    modelId: session.model,
  };
}
