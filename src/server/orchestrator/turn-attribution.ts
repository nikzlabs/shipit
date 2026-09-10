import type { AgentId } from "../shared/types.js";
import type { TurnAttribution, TurnCostSource } from "./usage.js";
import {
  getModel,
  nativeServiceForHarness,
  type ModelSelection,
} from "../shared/catalogue/index.js";
import type { ModelPrice } from "../shared/catalogue/types.js";

export interface TurnTokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Snapshot rates so later price changes or model retirement do not alter past costs. */
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

export function costFromRates(rates: ModelPrice, tokens: TurnTokens): number {
  const usd =
    (tokens.input ?? 0) * rates.input
    + (tokens.output ?? 0) * rates.output
    + (tokens.cacheRead ?? 0) * rates.cacheRead
    + (tokens.cacheWrite ?? 0) * rates.cacheWrite;
  return usd / 1_000_000;
}

export function resolveTurnCost(args: {
  harnessId: AgentId;
  attribution: TurnAttribution | undefined;
  // Undefined means unreported, not free.
  reportedCostUsd: number | undefined;
  tokens: TurnTokens;
  /** One-shot consults pass `per-turn`; harness totals default to `cumulative`. */
  reportedCostSource?: TurnCostSource;
}): { costUsd: number; costSource: TurnCostSource } {
  const { harnessId, attribution, reportedCostUsd, tokens } = args;
  const reportedSource = args.reportedCostSource ?? "cumulative";
  if (!attribution) {
    return { costUsd: reportedCostUsd ?? 0, costSource: reportedSource };
  }
  // Subscription turns incur no per-turn charge; rates support the API-cost comparison.
  if (attribution.billingMode === "sub") {
    return { costUsd: 0, costSource: "per-turn" };
  }
  const isNativeService = nativeServiceForHarness(harnessId) === attribution.serviceId;
  if (isNativeService && reportedCostUsd !== undefined) {
    return { costUsd: reportedCostUsd, costSource: reportedSource };
  }
  return { costUsd: costFromRates(attribution.rates, tokens), costSource: "per-turn" };
}

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
