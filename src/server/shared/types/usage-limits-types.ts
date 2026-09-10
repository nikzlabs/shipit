import type { BillingMode } from "../catalogue/types.js";
import { credentialModeKey } from "./domain-types/credential-route.js";

export type SubscriptionWindowName = "session" | "weekly";

export interface SubscriptionLimitsWindow {
  /** 0–100; null means unreported, so show the countdown without a percentage. */
  usedPct: number | null;
  resetAt: string;
  startedAt?: string;
  source?: "event" | "usage-api";
}

export interface SubscriptionLimits {
  serviceId: string;
  billingMode: BillingMode;
  routeId: string;
  plan: string | null;
  /** Null can mean not yet delivered, not necessarily absent from the plan. */
  session: SubscriptionLimitsWindow | null;
  weekly: SubscriptionLimitsWindow | null;
  /** Set only from complete plan readings. Absent or empty leaves all windows visible. */
  availableWindows?: SubscriptionWindowName[];
  fetchedAt: number;
  /** Epoch ms; suppress refresh during the provider's 429 lockout. */
  lockedUntil?: number;
}

// Expired telemetry must not demote a route whose next turn supplies the only fresh reading.
export function subscriptionWindowIsCurrent(
  window: { resetAt?: unknown } | null | undefined,
  now: number,
): boolean {
  if (typeof window?.resetAt !== "string") return false;
  const at = Date.parse(window.resetAt);
  return !Number.isNaN(at) && at > now;
}

/** serviceId:billingMode → route → snapshot. Broadcasts replace the map; missing readings are omitted. */
export type SubscriptionLimitsMap = Record<string, Record<string, SubscriptionLimits> | undefined>;

export function limitsModeKey(of: { serviceId: string; billingMode: BillingMode }): string {
  return credentialModeKey(of.serviceId, of.billingMode);
}

export type LimitsRefreshOutcome =
  | "updated"
  | "locked"
  | "rate-limited"
  | "no-credentials"
  | "expired-token"
  | "failed"
  | "unavailable"
  | "skipped";

export interface LimitsRefreshResult {
  routeId: string;
  outcome: LimitsRefreshOutcome;
  lockedUntil?: number;
  detail?: string;
}
