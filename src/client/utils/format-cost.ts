/**
 * docs/252 req 16 — money formatting, and the wording that keeps it honest.
 *
 * Three shapes, because this feature made "a dollar figure" three different
 * things and only one of them is money:
 *
 *  - {@link formatCost} — money that left the account.
 *  - {@link formatEstimate} — a value computed from ShipIt's own per-model
 *    rates. Always prefixed `≈`, and every caller pairs it with the words "at
 *    API rates". Labelling an estimate as the thing it approximates is the same
 *    dishonesty as trusting the CLI's own cost figure (`catalogue.md`,
 *    *Pricing*).
 *  - the legacy total — money of unknown provenance, shown unqualified and
 *    labelled as earlier accounting.
 *
 * Kept in one module so the dial and the usage modal cannot drift apart on the
 * one distinction the whole requirement rests on.
 */

import type { RunningFigureKind, TurnUsage } from "../../server/shared/types.js";

export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** Not money — a value at ShipIt's own API rates. Never rendered without a nearby "at API rates". */
export function formatEstimate(usd: number): string {
  return `≈${formatCost(usd)}`;
}

export const RUNNING_FIGURE_TITLE: Record<RunningFigureKind, string> = {
  metered: "Metered spend — ShipIt's estimate of what you were charged",

  "at-api-rates":
    "Covered by a subscription, not billed — shown at this provider's API rates, for comparison. Metered spend is listed separately.",
  earlier: "Recorded before ShipIt tracked where usage went — earlier accounting",
};

export function turnCostDisplay(turn: TurnUsage): { text: string; estimated: boolean } {
  if (turn.billingMode === "sub") {
    return turn.atApiRatesUsd === undefined
      ? { text: "included", estimated: false }
      : { text: formatEstimate(turn.atApiRatesUsd), estimated: true };
  }
  return { text: formatCost(turn.costUsd), estimated: false };
}
