import type { AgentId } from "../agent-types.js";

/**
 * Where a turn's credential came from.
 *
 * - `account` — a login flow produced a credential root on disk.
 * - `reserved` — env-supplied and singleton (`claude-api-key`,
 *   `claude-env-oauth`, `codex-api-key`).
 * - `string` — docs/252 phase 2: a user-managed secret stored per credential
 *   route. Neither of the other two: not singleton like `reserved`, and with no
 *   login flow or credential root like `account`. A string-delivered
 *   subscription (GLM's coding plan) needs several of these, which is the one
 *   piece of genuinely new persistence in that design.
 *
 * Nothing *pins* a session to a `string` route until phase 3 routes turns onto
 * custom services; the member exists here so the session column can carry it
 * and so the classification is stated once.
 */
export type ProviderRouteKind = "account" | "reserved" | "string";

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
  /**
   * docs/150 req 22 — the provider's own id for this account
   * (Claude `oauthAccount.accountUuid`, Codex `chatgpt_account_id`), recorded
   * when a sign-in completes.
   *
   * This is what makes two rows distinguishable as *accounts* rather than as
   * labels. Optional because it is unknowable for a row that has never
   * completed a sign-in, and for an install whose CLI does not report one —
   * both degrade to the pre-req-22 behaviour rather than failing the connect.
   */
  externalId?: string;
  /**
   * req 22 — true while `label` is ShipIt's, not the user's.
   *
   * A connect replaces a generated label with the email the provider reports,
   * and must not touch one the user typed. `undefined` (every row written
   * before this field existed) is treated as user-owned: leaving a stale label
   * alone is recoverable, overwriting a deliberate one is not.
   */
  labelIsGenerated?: boolean;
  status: ProviderAccountStatus;
  /**
   * docs/150 — there is deliberately **no** persisted quota snapshot or plan
   * label here. The pill's numbers and its plan label both come from the live
   * per-account snapshot in `LimitsRegistry`, and selection reads that same
   * live snapshot; a stored copy would be a second source of truth for a fact
   * that changes every turn. The one quota fact that must outlive a restart —
   * a hard exhaustion — is `exhaustedUntil` below, which is a scalar with a
   * built-in expiry rather than a snapshot that never goes stale. See
   * `plan.md` → "Struck: persisting quota snapshots onto accounts".
   */
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
