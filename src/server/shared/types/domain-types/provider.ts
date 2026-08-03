import type { AgentId } from "../agent-types.js";

export type ProviderRouteKind = "account" | "reserved";

export type ProviderAccountStatus = "ready" | "authenticating" | "auth_failed" | "unavailable";

export interface ProviderAccountCapabilities {
  models?: string[];
  supportsImages?: boolean;
  supportsReview?: boolean;
  supportedPermissionModes?: string[];
  source: "provider_profile" | "agent_init" | "manual_default";
  refreshedAt: number;
}

export interface ProviderAccount {
  id: string;
  provider: AgentId;
  label: string;
  isPrimary: boolean;
  /**
   * docs/150 req 2 — the user's fallback order for this provider, ascending
   * (0 is tried first). Authoritative for selection.
   *
   * Optional so rows written before this existed still load; those are ordered
   * the old way (primary first, then stored order) until the user reorders,
   * at which point every row gets an explicit value. A newly connected account
   * is appended rather than inserted, so connecting one never silently changes
   * which account existing work runs on.
   */
  priority?: number;
  status: ProviderAccountStatus;
  plan?: string | null;
  capabilities?: ProviderAccountCapabilities;
  lastUsedAt?: number;
  exhaustedUntil?: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * docs/150 reqs 4–6 — per-provider proactive failover cutoffs, as percentages
 * of a quota window (1–100).
 *
 * A cutoff is a **preference, not a wall**. Reaching one moves new work to the
 * next eligible account, but an account past its cutoff is still perfectly
 * capable of running a turn — it only stops being the *first* choice. That
 * distinction is what keeps a 90% setting from being worse than no failover at
 * all once every account is above it.
 */
export interface FailoverCutoffs {
  /** Short rolling window (Claude: 5h, Codex: 5h). */
  session: number;
  /** Weekly window. */
  weekly: number;
}

/** req 5 — both cutoffs default to 90%. */
export const DEFAULT_FAILOVER_CUTOFF = 90;

/**
 * docs/150 req 21 — how a provider's accounts relate to each other, which an
 * ordered list alone cannot say.
 *
 * - `strict` — the order IS a preference. Work starts on the highest-ranked
 *   eligible account; a lower-ranked one runs only while the accounts above it
 *   are ineligible. Right when the accounts are unequal (Max 20x before Pro,
 *   work before personal), which is what ordering them already expressed.
 * - `balanced` — the accounts are peers. Work is spread so their quota drains
 *   at a comparable rate, and the order degrades to a display/tie-break order
 *   (req 2). Right when the accounts are interchangeable, where `strict` would
 *   drive one to its cutoff while the other sat unused.
 *
 * This decides where work *starts*, never *whether* failover happens — req 15
 * keeps that on unconditionally, and both modes fail over identically.
 *
 * The choice only ever applies at the moment a session pins its route: turns
 * are serialized per session and a session reuses its pinned account, so
 * "spreading work" means spreading *sessions*, not turns within one.
 */
export type AccountSelectionMode = "strict" | "balanced";

/** req 21 — strict is the default, so an untouched install is unchanged. */
export const DEFAULT_SELECTION_MODE: AccountSelectionMode = "strict";
