import type { AgentId, AgentRequestUsage } from "../shared/types.js";
import type { TurnAttribution, TurnCostSource } from "./usage.js";
import {
  getModel,
  nativeServiceForHarness,
  type ModelSelection,
} from "../shared/catalogue/index.js";
import type { FlatPrice, ModelPrice } from "../shared/catalogue/types.js";

export interface TurnTokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** What prices a turn: its totals, and where the harness reports them, its requests. */
export interface PricedUsage {
  tokens: TurnTokens;
  requests?: readonly AgentRequestUsage[] | undefined;
  /** The last request's prompt; the estimate for whatever `requests` does not cover. */
  contextTokens?: number | undefined;
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

function flatUsd(rates: FlatPrice, tokens: TurnTokens): number {
  return (
    (tokens.input ?? 0) * rates.input
    + (tokens.output ?? 0) * rates.output
    + (tokens.cacheRead ?? 0) * rates.cacheRead
    + (tokens.cacheWrite ?? 0) * rates.cacheWrite
  ) / 1_000_000;
}

function ratesForPrompt(price: ModelPrice, promptTokens: number | undefined): FlatPrice {
  const tier = price.longPrompt;
  return tier && promptTokens !== undefined && promptTokens > tier.aboveTokens ? tier : price;
}

/**
 * docs/329-tiered-model-pricing — each listed request at the tier its own
 * prompt selects; the totals beyond the list (per field, floored at zero) at
 * the tier `contextTokens` selects, or the lower tier when that is unknown.
 */
export function costFromRates(price: ModelPrice, usage: PricedUsage): number {
  const { tokens } = usage;
  if (!price.longPrompt) return flatUsd(price, tokens);
  let usd = 0;
  const listed = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const request of usage.requests ?? []) {
    const prompt = request.input + (request.cacheRead ?? 0) + (request.cacheWrite ?? 0);
    usd += flatUsd(ratesForPrompt(price, prompt), request);
    listed.input += request.input;
    listed.output += request.output ?? 0;
    listed.cacheRead += request.cacheRead ?? 0;
    listed.cacheWrite += request.cacheWrite ?? 0;
  }
  const remainder: TurnTokens = {
    input: Math.max(0, (tokens.input ?? 0) - listed.input),
    output: Math.max(0, (tokens.output ?? 0) - listed.output),
    cacheRead: Math.max(0, (tokens.cacheRead ?? 0) - listed.cacheRead),
    cacheWrite: Math.max(0, (tokens.cacheWrite ?? 0) - listed.cacheWrite),
  };
  return usd + flatUsd(ratesForPrompt(price, usage.contextTokens), remainder);
}

/** A subscription row's "at API rates" figure; undefined for any other row. */
export function atApiRatesFor(attribution: TurnAttribution | undefined, usage: PricedUsage): number | undefined {
  return attribution?.billingMode === "sub" ? costFromRates(attribution.rates, usage) : undefined;
}

export function resolveTurnCost(args: {
  /** Undefined where no harness ran the work, which reports no cost of its own. */
  harnessId: AgentId | undefined;
  attribution: TurnAttribution | undefined;
  // Undefined means unreported, not free.
  reportedCostUsd: number | undefined;
  usage: PricedUsage;
  /** One-shot consults pass `per-turn`; harness totals default to `cumulative`. */
  reportedCostSource?: TurnCostSource;
}): { costUsd: number; costSource: TurnCostSource } {
  const { harnessId, attribution, reportedCostUsd } = args;
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
  return { costUsd: costFromRates(attribution.rates, args.usage), costSource: "per-turn" };
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
