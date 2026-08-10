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
