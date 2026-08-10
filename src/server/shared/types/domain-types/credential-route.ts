/**
 * docs/252 phase 2 — the user's credentials, keyed by `(service, billing mode)`.
 *
 * This is the **only** credential shape. It replaced the `ProviderAccount`
 * record docs/150 stored, which survived for a while as an account-shaped
 * projection over these rows and was deleted by planning#342 once the routing
 * machinery (`provider-account-manager.ts`) was re-keyed off `AgentId`.
 *
 * Two things changed from that record:
 *
 *   - keyed by `(serviceId, billingMode)` instead of `provider: AgentId`, which
 *     is the conflation this feature removes; and
 *   - `via` distinguishes a login-flow account from a supplied secret, so
 *     plural string-delivered subscriptions (GLM's coding plan) become
 *     expressible. A supplied secret used to occupy a single named slot that
 *     the next write overwrote, which would leave req 12 with nothing to fail
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

/** How a credential reaches the CLI. Delivery only — see the file docstring. */
export type CredentialVia = "account" | "string";

/**
 * Whether this credential can authenticate a turn right now.
 *
 * The two middle states only ever apply to a `via: "account"` credential, which
 * is the only kind with a login flow behind it: a row exists from the moment
 * "Add account" is clicked (`unavailable`), goes `authenticating` while the
 * CLI's sign-in runs, and lands on `ready` or `auth_failed`. A supplied secret
 * is `ready` the moment it is stored — there is nothing to wait for and nothing
 * that can half-succeed.
 */
export type CredentialStatus = "ready" | "authenticating" | "auth_failed" | "unavailable";

/** What the provider reports this credential can do, refreshed on sign-in. */
export interface CredentialCapabilities {
  models?: string[];
  supportsImages?: boolean;
  supportsReview?: boolean;
  supportedPermissionModes?: string[];
  source: "provider_profile" | "agent_init" | "manual_default";
  refreshedAt: number;
}

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
  status: CredentialStatus;
  /**
   * docs/150 — there is deliberately **no** persisted quota snapshot or plan
   * label here. The pill's numbers and its plan label both come from the live
   * per-credential snapshot in `LimitsRegistry`, and selection reads that same
   * live snapshot; a stored copy would be a second source of truth for a fact
   * that changes every turn. The one quota fact that must outlive a restart —
   * a hard exhaustion — is `exhaustedUntil` below, which is a scalar with a
   * built-in expiry rather than a snapshot that never goes stale. See
   * docs/150's `plan.md` → "Struck: persisting quota snapshots onto accounts".
   */
  capabilities?: CredentialCapabilities;
  lastUsedAt?: number;
  exhaustedUntil?: number | null;
  /** When the provider last reported hard exhaustion for this credential. */
  exhaustedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * docs/260 req 9 — how long a harness quota refusal may block a credential
 * before it is re-tried. The cap is the insurance against a wrong or stale
 * refusal record: whatever `exhaustedUntil` claims, the credential is probed
 * again within this window, and a refusal that was wrong self-heals at the
 * cost of one attempt.
 */
export const REFUSAL_REPROBE_MS = 30 * 60_000;

/**
 * docs/260 req 9 — the ONLY reading of `exhaustedUntil`/`exhaustedAt`, shared
 * by the account walk and the string-credential walk so the two shapes cannot
 * drift (req 11).
 *
 * A credential is refusal-blocked while
 * `now < min(exhaustedUntil, exhaustedAt + REFUSAL_REPROBE_MS)` — honoured
 * until the provider-stated reset, but re-probed within the cap. Returns the
 * epoch-ms the block lifts, or `null` when the credential is not blocked.
 *
 * A row with `exhaustedUntil` but no `exhaustedAt` (a pre-260 bench, or a
 * string credential stamped before the clock existed) reads as expired —
 * deliberately: only a refusal the harness actually reported, with its
 * observation time, may block a turn (req 5), and the missing clock is
 * exactly the state the 2026-08-10 incident showed can go permanently stale.
 */
export function refusalBlockedUntil(
  route: Pick<CredentialRoute, "exhaustedUntil" | "exhaustedAt">,
  now: number,
): number | null {
  if (typeof route.exhaustedUntil !== "number") return null;
  if (typeof route.exhaustedAt !== "number") return null;
  const until = Math.min(route.exhaustedUntil, route.exhaustedAt + REFUSAL_REPROBE_MS);
  return until > now ? until : null;
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
