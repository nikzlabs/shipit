// Delivery and billing are independent; never put secrets on these Settings wire records.
export type CredentialVia = "account" | "string";

/** Non-ready accounts are excluded from routing; failed string credentials remain retryable. */
export type CredentialStatus = "ready" | "authenticating" | "auth_failed" | "unavailable";

export interface CredentialCapabilities {
  models?: string[];
  supportsImages?: boolean;
  supportsReview?: boolean;
  supportedPermissionModes?: string[];
  source: "provider_profile" | "agent_init" | "manual_default";
  refreshedAt: number;
}

export type CredentialBillingMode = "sub" | "key";

export interface CredentialRoute {
  id: string;
  serviceId: string;
  billingMode: CredentialBillingMode;
  via: CredentialVia;
  label: string;
  /** Connect may replace generated labels, never user-authored ones. */
  labelIsGenerated?: boolean;
  externalId?: string;
  /** Derived from priority on read; not authoritative on disk. */
  isPrimary: boolean;
  priority?: number;
  status: CredentialStatus;
  capabilities?: CredentialCapabilities;
  lastUsedAt?: number;
  exhaustedUntil?: number | null;
  exhaustedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

// Cap stale refusals so an incorrect provider reset time cannot block a route indefinitely.
export const REFUSAL_REPROBE_MS = 30 * 60_000;

/** Missing observation time expires legacy refusals. Returns epoch ms, or null if unblocked. */
export function refusalBlockedUntil(
  route: Pick<CredentialRoute, "exhaustedUntil" | "exhaustedAt">,
  now: number,
): number | null {
  if (typeof route.exhaustedUntil !== "number") return null;
  if (typeof route.exhaustedAt !== "number") return null;
  const until = Math.min(route.exhaustedUntil, route.exhaustedAt + REFUSAL_REPROBE_MS);
  return until > now ? until : null;
}

export function credentialModeKey(serviceId: string, billingMode: CredentialBillingMode): string {
  return `${serviceId}:${billingMode}`;
}

// Unranked legacy routes sort last in storage order, rather than becoming primary.
export function orderCredentialRoutes<T extends { priority?: number; isPrimary: boolean }>(
  routes: readonly T[],
): T[] {
  return routes
    .map((route, index) => ({ route, index }))
    .sort(
      (a, b) =>
        (a.route.priority ?? Number.POSITIVE_INFINITY) - (b.route.priority ?? Number.POSITIVE_INFINITY)
        || a.index - b.index,
    )
    .map((entry, index) => ({ ...entry.route, isPrimary: index === 0 }));
}

// Route-specific delivery prevents failover from using the group's first credential.
export const CREDENTIAL_ROUTE_ENV_PREFIX = "SHIPIT_CREDENTIAL_";

export function credentialRouteEnvName(routeId: string): string {
  return CREDENTIAL_ROUTE_ENV_PREFIX + routeId.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

export function parseCredentialModeKey(
  key: string,
): { serviceId: string; billingMode: CredentialBillingMode } | undefined {
  const at = key.indexOf(":");
  if (at <= 0) return undefined;
  const serviceId = key.slice(0, at);
  const billingMode = key.slice(at + 1);
  if (billingMode !== "sub" && billingMode !== "key") return undefined;
  return { serviceId, billingMode };
}
