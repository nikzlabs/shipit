/**
 * docs/252 phase 2 — the user's credentials, keyed by `(service, billing mode)`.
 *
 * This is the type that replaces {@link ProviderAccount} as the *storage* shape.
 * `ProviderAccount` survives as the account-shaped projection the docs/150
 * routing machinery still speaks (see `credential-store.ts`), and phase 3 —
 * which moves eligibility and turn routing off `AgentId` — is what retires it.
 *
 * Two things change from `ProviderAccount` (`provider.ts`):
 *
 *   - keyed by `(serviceId, billingMode)` instead of `provider: AgentId`, which
 *     is the conflation this feature removes; and
 *   - `via` distinguishes a login-flow account from a supplied secret, so
 *     plural string-delivered subscriptions (GLM's coding plan) become
 *     expressible. A supplied secret today occupies a single named slot that
 *     the next write overwrites, which would leave req 12 with nothing to fail
 *     over to.
 *
 * **`via` is delivery, never billing.** A subscription can be delivered as a
 * string (`claude-env-oauth`; GLM's coding plan), and a subscription can be
 * authenticated by an API key. Branch on `billingMode` for every billing
 * question — fail over? show a quota? money or allowance? — and on `via` only
 * for "where does the secret come from and where does it land".
 *
 * **No secret on this record.** A `via: "string"` credential's secret lives in
 * the credential store keyed by route id, exactly as a `via: "account"`
 * credential's root lives on disk keyed by account id. That symmetry is what
 * keeps this type safe to return verbatim through Settings, which is what
 * happens today (`services/settings.ts`).
 */

import type { ProviderAccountCapabilities, ProviderAccountStatus } from "./provider.js";

/** How a credential reaches the CLI. Delivery only — see the file docstring. */
export type CredentialVia = "account" | "string";

/** `sub` is an allowance (a subscription or plan); `key` is metered per token. */
export type CredentialBillingMode = "sub" | "key";

export interface CredentialRoute {
  /** The route id, as today (`acct_…` for accounts, `cred_…` for strings). */
  id: string;
  serviceId: string;
  billingMode: CredentialBillingMode;
  via: CredentialVia;
  label: string;
  /**
   * docs/150 req 22 — true while `label` is ShipIt's, not the user's. A connect
   * replaces a generated label with the email the provider reports and must not
   * touch one the user typed.
   */
  labelIsGenerated?: boolean;
  /** docs/150 req 22 — the provider's own id, for duplicate detection. */
  externalId?: string;
  /**
   * Derived on read from `priority` (`index === 0` after sorting), but part of
   * the wire shape the client already reads. Never authoritative on disk.
   */
  isPrimary: boolean;
  /** docs/150 req 2 — authoritative fallback order, ascending. */
  priority?: number;
  status: ProviderAccountStatus;
  capabilities?: ProviderAccountCapabilities;
  lastUsedAt?: number;
  exhaustedUntil?: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * The key a `(service, billing mode)` pair is stored under in the settings maps
 * that used to be keyed by `AgentId` — `accountSelectionMode` and
 * `failoverCutoffs`.
 *
 * A flat string rather than a nested record because both maps are JSON on disk
 * and cross the wire to the browser, where a nested shape would mean two levels
 * of optional-chaining at every read for no gain. The separator is `:`, which no
 * `serviceId` contains.
 */
export function credentialModeKey(serviceId: string, billingMode: CredentialBillingMode): string {
  return `${serviceId}:${billingMode}`;
}

/**
 * docs/150 reqs 2 and 19 — put a group's credentials in **selection order** and
 * stamp `isPrimary` from position.
 *
 * The order lives in one function because a credential list has no other order:
 * `reorder` writes `priority` and the router reads it, but storage order never
 * moves, so a caller reading raw storage sees the order the user had before
 * they ever touched the control. "Primary" is position 0 of that order and
 * nothing else — a stored flag would be a second copy of one fact, which is
 * what req 19 removed.
 *
 * A row with no `priority` sorts after every row that has one, by storage
 * order. Sorting them last beats treating a missing value as 0, which would
 * silently promote a legacy row to primary.
 */
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

/**
 * The environment variable one **specific** stored credential is materialized
 * under (docs/252 phase 5).
 *
 * A mode's `storageEnv` names the *group*, so it can only ever carry one of the
 * group's credentials — phase 2 delivered the first in order and said so. That
 * was sufficient while nothing could pick a different one; req 12's failover is
 * exactly a reason to pick a different one, and without a per-credential name
 * the session would authenticate with the benched key while attributing the
 * turn to the one it failed over to.
 *
 * So every stored string credential is delivered under both names: the group's,
 * unchanged, and this one. Spawn shaping then reads the pinned route's own
 * variable when there is one, and the group's otherwise — which is what an
 * environment-delivered credential (no row, no id) still has.
 *
 * The prefix is ShipIt's own namespace rather than a catalogue name, so it can
 * never collide with a variable a harness or a repo's compose file reads.
 */
export const CREDENTIAL_ROUTE_ENV_PREFIX = "SHIPIT_CREDENTIAL_";

/** True for a route id the credential store owns (as opposed to a legacy env route). */
export function isStoredCredentialRouteId(routeId: string): boolean {
  return routeId.startsWith("cred_");
}

export function credentialRouteEnvName(routeId: string): string {
  return CREDENTIAL_ROUTE_ENV_PREFIX + routeId.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

/** Inverse of {@link credentialModeKey}; `undefined` for anything else. */
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
