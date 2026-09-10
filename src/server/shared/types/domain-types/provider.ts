/** Reserved routes are environment singletons; string routes store separate secrets. */
export type ProviderRouteKind = "account" | "reserved" | "string";

/** Percentages (1–100); cutoffs lower preference but do not forbid a turn. */
export interface FailoverCutoffs {
  session: number;
  weekly: number;
}

export const DEFAULT_FAILOVER_CUTOFF = 90;

// Chooses the initial session pin; both modes still fail over.
export type AccountSelectionMode = "strict" | "balanced";

export const DEFAULT_SELECTION_MODE: AccountSelectionMode = "strict";
