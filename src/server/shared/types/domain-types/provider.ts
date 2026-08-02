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
