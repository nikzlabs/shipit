import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentId,
  FailoverCutoffs,
  ProviderAccount,
  ProviderRouteKind,
  SubscriptionLimitsMap,
} from "../shared/types.js";
import type { CredentialStore } from "./credential-store.js";
import type { AgentAuthManager } from "./agent-auth-manager.js";

/** Persisted, non-derived account statuses (see {@link ProviderAccount}). */
export type ProviderAccountStatus = ProviderAccount["status"];

const PROVIDER_ACCOUNTS_SUBDIR = "provider-accounts";

const PROVIDER_LABEL: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
};

const LEGACY_CREDENTIAL_PATHS: Record<AgentId, readonly string[]> = {
  claude: [".claude", ".claude.json"],
  codex: [".codex"],
};

export interface ProviderRoute {
  kind: ProviderRouteKind;
  id: string;
}

export interface ProviderAccountManagerOptions {
  credentialsDir: string;
  credentialStore: CredentialStore;
  /**
   * docs/150 — read the current account-keyed quota snapshot. Injected rather
   * than imported so this manager stays free of the limits registry (which is
   * constructed later and depends on the agent runtime). Absent in tests and
   * before the registry exists, in which case quota is simply unknown and every
   * connected account is considered usable.
   */
  getSubscriptionLimits?: () => SubscriptionLimitsMap;
}

/**
 * Why an account could not be selected (docs/150 reqs 13, 17). A bare `null`
 * could not express any of these, and reqs 13 and 17 are specifically about
 * *telling the user which one happened* — "everything is exhausted until 14:30"
 * and "no connected account can run this model" are different problems with
 * different fixes.
 */
export type AccountSelectionFailure =
  /** Nothing is connected (or everything needs re-auth). */
  | { reason: "auth_required" }
  /**
   * Every connected account has a window at 100%. `earliestResetAt` is the
   * soonest any of them frees up, so req 13 can say when — `null` only if no
   * exhausted window carried a parseable reset time.
   */
  | { reason: "all_exhausted"; earliestResetAt: string | null }
  /**
   * Accounts are available but none reports the requested model (req 17). We
   * skip and report rather than silently substituting a model the user did not
   * ask for.
   */
  | { reason: "no_model_eligible_account"; model: string };

export type AccountSelection =
  | { ok: true; route: ProviderRoute }
  | ({ ok: false } & AccountSelectionFailure);

export interface SelectAccountOptions {
  /** Model the turn intends to run, when known — drives req 17's skip-and-report. */
  model?: string;
  /**
   * Routes already tried and failed this turn. Mid-turn failover (req 14)
   * passes the exhausted route so the retry cannot pick it again.
   */
  exclude?: readonly string[];
}

/**
 * App-scoped provider-account registry for docs/150 Phase 1.
 *
 * Later phases add account-scoped auth flows, quota ranking, and failover. This
 * first slice owns the stable storage paths, default-account migration, primary
 * account selection, and coarse authConfigured predicate used by AgentRegistry.
 */
export class ProviderAccountManager {
  private credentialsDir: string;
  private credentialStore: CredentialStore;
  /**
   * Per-provider auth managers, attached after construction (the managers are
   * built in `app-di`/`buildAgentRuntime`, after this manager). Used to drive
   * account-scoped login/cancel/sign-out flows. `null` until attached — the
   * scoped-auth methods throw a clear error if invoked before wiring.
   */
  private authManagers: Map<AgentId, AgentAuthManager> | null = null;

  private getSubscriptionLimits: (() => SubscriptionLimitsMap) | undefined;

  constructor(opts: ProviderAccountManagerOptions) {
    this.credentialsDir = opts.credentialsDir;
    this.credentialStore = opts.credentialStore;
    this.getSubscriptionLimits = opts.getSubscriptionLimits;
  }

  /**
   * Late-bind the quota source. `LimitsRegistry` is constructed after this
   * manager (it needs the agent runtime), so the wiring cannot be a constructor
   * argument in the real app.
   */
  attachSubscriptionLimits(getSubscriptionLimits: () => SubscriptionLimitsMap): void {
    this.getSubscriptionLimits = getSubscriptionLimits;
  }

  /**
   * Wire the per-provider auth managers so this manager can start/cancel
   * account-scoped login flows (docs/150). Called once from `index.ts` after
   * `buildAgentRuntime`.
   */
  attachAuthManagers(authManagers: Map<AgentId, AgentAuthManager>): void {
    this.authManagers = authManagers;
  }

  migrateDefaultAccounts(): void {
    this.migrateProviderDefault("claude", "claude-default", "Primary Anthropic account");
    this.migrateProviderDefault("codex", "codex-default", "Primary ChatGPT account");
  }

  list(provider?: AgentId): ProviderAccount[] {
    return this.credentialStore.listProviderAccounts(provider);
  }

  get(provider: AgentId, accountId: string): ProviderAccount | undefined {
    return this.credentialStore.getProviderAccount(provider, accountId);
  }

  getPrimary(provider: AgentId): ProviderAccount | undefined {
    return this.credentialStore.getPrimaryProviderAccount(provider);
  }

  /**
   * This provider's accounts, primary first, then the remaining rows in stored
   * order. The de-dup guards the case where the store has no row flagged
   * primary and `getPrimaryProviderAccount` falls back to `accounts[0]` —
   * without it that row would be visited twice.
   */
  private accountsInSelectionOrder(provider: AgentId): ProviderAccount[] {
    const accounts = this.list(provider);
    const primary = this.getPrimary(provider);
    if (!primary) return accounts;
    return [primary, ...accounts.filter((account) => account.id !== primary.id)];
  }

  create(provider: AgentId, label?: string): ProviderAccount {
    const now = Date.now();
    const existing = this.list(provider);
    const account: ProviderAccount = {
      id: `acct_${randomUUID()}`,
      provider,
      label: normalizeLabel(label) ?? `${PROVIDER_LABEL[provider]} account ${existing.length + 1}`,
      isPrimary: existing.length === 0,
      status: "unavailable",
      capabilities: {
        source: "manual_default",
        refreshedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    };
    fs.mkdirSync(this.resolveCredentialRoot(provider, account.id), { recursive: true });
    this.credentialStore.upsertProviderAccount(account);
    return this.get(provider, account.id) ?? account;
  }

  rename(provider: AgentId, accountId: string, label: string): ProviderAccount {
    const account = this.require(provider, accountId);
    const normalized = normalizeLabel(label);
    if (!normalized) throw new Error("Provider account label cannot be empty");
    if (normalized.length > 120) throw new Error("Provider account label is too long (max 120 characters)");
    this.credentialStore.upsertProviderAccount({ ...account, label: normalized });
    return this.require(provider, accountId);
  }

  makePrimary(provider: AgentId, accountId: string): ProviderAccount {
    const account = this.require(provider, accountId);
    this.credentialStore.upsertProviderAccount({ ...account, isPrimary: true });
    return this.require(provider, accountId);
  }

  delete(provider: AgentId, accountId: string): void {
    this.require(provider, accountId);
    fs.rmSync(this.resolveCredentialRoot(provider, accountId), { recursive: true, force: true });
    this.credentialStore.deleteProviderAccount(provider, accountId);
  }

  require(provider: AgentId, accountId: string): ProviderAccount {
    const account = this.get(provider, accountId);
    if (!account) throw new Error(`Provider account not found: ${provider}/${accountId}`);
    return account;
  }

  /**
   * Pick the auth route for the next turn with this provider.
   *
   * Walks **every** stored account — primary first, then the rest in stored
   * order — and only falls back to the reserved env/API-key routes when no
   * stored account is usable. Consulting just the primary (the shape this had
   * through Phase 1) meant a user with two connected subscriptions lost access
   * to the healthy one the moment the primary's auth failed: selection returned
   * null while `hasAnyAuthForProvider` still reported true, and with
   * `ANTHROPIC_API_KEY` set in the environment it silently routed the turn onto
   * metered Platform API billing instead of the working subscription. That
   * contradicts docs/150 req 3 (continue on another connected account) and
   * req 12 (never route onto pay-as-you-go billing because a subscription is
   * unavailable).
   *
   * Ordering here is "primary, then stored order" — the user-controlled
   * priority list (req 2) and quota-aware ranking (reqs 6/7) land with the
   * later phases; this is the eligibility walk they will extend, not the final
   * policy.
   */
  selectRouteForTurn(provider: AgentId): ProviderRoute | null {
    const selection = this.selectAccountForTurn(provider);
    return selection.ok ? selection.route : null;
  }

  /** Metered env/API-key fallback for a provider, if one is configured. */
  private reservedRouteFor(provider: AgentId): ProviderRoute | null {
    if (provider === "claude") {
      if (process.env.ANTHROPIC_AUTH_TOKEN?.trim()) return { kind: "reserved", id: "claude-env-oauth" };
      if (process.env.ANTHROPIC_API_KEY?.trim()) return { kind: "reserved", id: "claude-api-key" };
    }
    if (provider === "codex" && process.env.OPENAI_API_KEY?.trim()) {
      return { kind: "reserved", id: "codex-api-key" };
    }
    return null;
  }

  /**
   * docs/150 — the turn-routing decision, with a reason when it fails.
   *
   * This is {@link selectRouteForTurn} widened: same eligibility walk, but it
   * also skips accounts whose quota is spent (reqs 6, 7), honours an exclusion
   * list so a mid-turn retry cannot land back on the account that just ran out
   * (req 14), skips accounts that cannot run the requested model (req 17), and
   * distinguishes *why* nothing was selectable so the caller can tell the user
   * (req 13). `selectRouteForTurn` remains as the thin "just give me a route"
   * wrapper for callers that have nothing useful to do with the reason.
   *
   * Reserved env/API-key routes are the last resort and are never treated as
   * exhausted — they are metered billing, not a subscription window, and
   * req 12 keeps failover from *choosing* them; they are only reachable when no
   * stored account is usable at all, which is the manual-selection case.
   */
  selectAccountForTurn(provider: AgentId, opts: SelectAccountOptions = {}): AccountSelection {
    const exclude = new Set(opts.exclude ?? []);
    const connected = this.accountsInSelectionOrder(provider).filter(
      (account) =>
        (account.status === "ready" || account.status === "authenticating") &&
        !exclude.has(account.id),
    );

    const limits = this.getSubscriptionLimits?.()?.[provider] ?? {};
    const now = Date.now();

    // Partition rather than short-circuit: which bucket the *last* candidate
    // falls into is what decides the failure reason, so we need all of them.
    const modelEligible: ProviderAccount[] = [];
    let skippedForModel = false;
    for (const account of connected) {
      if (opts.model && !accountSupportsModel(account, opts.model)) {
        skippedForModel = true;
        continue;
      }
      modelEligible.push(account);
    }

    // docs/150 reqs 4–6 — three tiers, not two. An account past its cutoff is
    // still perfectly capable of running the turn; it has just stopped being
    // the *first* choice. Collapsing "past cutoff" into "exhausted" would make
    // a 90% setting strictly worse than no failover at all: once every account
    // crossed 90%, every turn would fail with `all_exhausted` while ten percent
    // of quota sat unused on each one.
    const cutoffs = this.credentialStore.getFailoverCutoffs(provider);
    const overCutoff: ProviderAccount[] = [];
    const exhaustedResets: number[] = [];
    for (const account of modelEligible) {
      const resetAt = exhaustedUntil(limits[account.id], account, now);
      if (resetAt !== null) {
        exhaustedResets.push(resetAt);
        continue;
      }
      if (isOverCutoff(limits[account.id], cutoffs)) {
        overCutoff.push(account);
        continue;
      }
      return { ok: true, route: { kind: "account", id: account.id } };
    }
    // Nothing under its cutoff, but these still work. Preferring the first in
    // priority order keeps the choice stable rather than hunting for whichever
    // account is marginally least used.
    const fallback = overCutoff[0];
    if (fallback) return { ok: true, route: { kind: "account", id: fallback.id } };

    // req 12 — a *spent* subscription must never silently roll onto
    // pay-as-you-go billing. The reserved env/API-key route is only reachable
    // when the user has no usable subscription at all (the manual-auth case),
    // never as the next hop after one runs out. Ordering this check after the
    // reserved fallback would spend the user's money on their behalf, which is
    // the one outcome this feature must not produce.
    if (exhaustedResets.length > 0) {
      const earliest = Math.min(...exhaustedResets);
      return {
        ok: false,
        reason: "all_exhausted",
        earliestResetAt: Number.isFinite(earliest) ? new Date(earliest).toISOString() : null,
      };
    }
    if (skippedForModel && opts.model) {
      return { ok: false, reason: "no_model_eligible_account", model: opts.model };
    }

    // No connected subscription at all — fall back to reserved routes so
    // env/API-key users keep working.
    const reserved = this.reservedRouteFor(provider);
    if (reserved && !exclude.has(reserved.id)) return { ok: true, route: reserved };
    return { ok: false, reason: "auth_required" };
  }

  /**
   * docs/150 reqs 3, 7, 8 — can the route a session is **already pinned to**
   * still run a turn?
   *
   * `selectAccountForTurn` cannot answer this: it returns the *best* route in
   * priority order, so a session healthily pinned to a secondary account would
   * see it name the primary and read that as "you have been skipped." The
   * eligibility rules are the same, asked about one route instead of all of
   * them.
   *
   * Reserved env/API-key routes are always usable. They are metered billing,
   * not a subscription window, so there is nothing to exhaust — and req 12
   * means nothing may move a turn off them for quota reasons either.
   * A pinned account that has since been deleted or signed out reports
   * unusable, which sends the caller back through the router.
   */
  isRouteUsableForTurn(
    provider: AgentId,
    route: ProviderRoute,
    opts: Pick<SelectAccountOptions, "model"> = {},
  ): boolean {
    if (route.kind !== "account") return true;
    const account = this.get(provider, route.id);
    if (!account) return false;
    if (account.status !== "ready" && account.status !== "authenticating") return false;
    if (opts.model && !accountSupportsModel(account, opts.model)) return false;
    const limits = this.getSubscriptionLimits?.()?.[provider] ?? {};
    if (exhaustedUntil(limits[route.id], account, Date.now()) !== null) return false;

    // docs/150 req 6 — past a cutoff, this session should move to the next
    // eligible account. But only if there IS somewhere better: reporting
    // "unusable" when every account is above its cutoff would hand
    // `failoverPinnedSession` a different over-cutoff account each turn and
    // churn the session between them for no benefit, killing the resident
    // process every time. A cutoff is a preference, so it can only displace a
    // session onto an account that is actually under one.
    const cutoffs = this.credentialStore.getFailoverCutoffs(provider);
    if (!isOverCutoff(limits[route.id], cutoffs)) return true;
    // "Somewhere better" means an account genuinely UNDER its cutoff — not
    // merely whichever account the selector would name first. Asking the
    // selector here would compare against its over-cutoff fallback, so a
    // session pinned to the second over-cutoff account would be displaced onto
    // the first one, then back, killing the resident process each turn.
    const now = Date.now();
    const hasBetter = this.accountsInSelectionOrder(provider).some((candidate) => {
      if (candidate.id === route.id) return false;
      if (candidate.status !== "ready" && candidate.status !== "authenticating") return false;
      if (opts.model && !accountSupportsModel(candidate, opts.model)) return false;
      if (exhaustedUntil(limits[candidate.id], candidate, now) !== null) return false;
      return !isOverCutoff(limits[candidate.id], cutoffs);
    });
    return !hasBetter;
  }

  hasAnyAuthForProvider(provider: AgentId): boolean {
    if (this.list(provider).some((account) => account.status === "ready")) return true;
    if (provider === "claude") {
      return Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim());
    }
    return Boolean(process.env.OPENAI_API_KEY?.trim());
  }

  resolveCredentialRoot(provider: AgentId, accountId: string): string {
    return path.join(this.credentialsDir, PROVIDER_ACCOUNTS_SUBDIR, provider, accountId);
  }

  /**
   * docs/150 req 7 — stamp an account as out of quota until `until` (epoch ms).
   *
   * This is the *hard* exhaustion signal: the provider failed a turn saying the
   * subscription is spent. It has to be persisted rather than inferred from the
   * live quota snapshot, because that snapshot is telemetry — it can lag the
   * failure, can report `usedPct: null` below a warning threshold, and for a
   * freshly connected account may not exist at all. Without the stamp the
   * router would keep choosing the account that just refused the turn.
   *
   * Only ever moves the stamp *later*, so a second failure carrying a vaguer
   * reset can't shorten a lockout the provider already told us the end of.
   * Reserved routes are not accounts and are silently ignored (req 12 — metered
   * billing has no subscription window).
   */
  markAccountExhausted(provider: AgentId, accountId: string, until: number): ProviderAccount | null {
    const account = this.get(provider, accountId);
    if (!account) return null;
    if (typeof account.exhaustedUntil === "number" && account.exhaustedUntil >= until) {
      return account;
    }
    this.credentialStore.upsertProviderAccount({ ...account, exhaustedUntil: until });
    return this.get(provider, accountId) ?? null;
  }

  /** Overwrite the persisted status of an account (idempotent). */
  setAccountStatus(provider: AgentId, accountId: string, status: ProviderAccountStatus): ProviderAccount {
    const account = this.require(provider, accountId);
    if (account.status === status) return account;
    this.credentialStore.upsertProviderAccount({ ...account, status });
    return this.require(provider, accountId);
  }

  // ---- Account-scoped auth flows (docs/150) ----

  /**
   * Start the provider's login flow scoped to a specific account row. The
   * provider CLI is spawned with `HOME` pointed at the account's credential
   * root, so it writes into `provider-accounts/<provider>/acct_<id>/...`
   * instead of the singleton path. Marks the row `authenticating`; the
   * eventual `complete`/`failed` event (handled in `app-lifecycle`) flips it
   * to `ready`/`auth_failed`.
   */
  startAccountAuth(provider: AgentId, accountId: string): ProviderAccount {
    this.require(provider, accountId);
    const mgr = this.requireAuthManager(provider);
    const credentialDir = this.resolveCredentialRoot(provider, accountId);
    fs.mkdirSync(credentialDir, { recursive: true });
    const account = this.setAccountStatus(provider, accountId, "authenticating");
    mgr.start({ accountId, credentialDir });
    return account;
  }

  /**
   * Cancel an in-flight scoped login. Resets the row's status to `ready` when
   * the account already has on-disk credentials, otherwise `unavailable`.
   */
  cancelAccountAuth(provider: AgentId, accountId: string): ProviderAccount {
    this.require(provider, accountId);
    const mgr = this.requireAuthManager(provider);
    mgr.cancel();
    const credentialDir = this.resolveCredentialRoot(provider, accountId);
    const status: ProviderAccountStatus = mgr.isConfigured({ credentialDir }) ? "ready" : "unavailable";
    return this.setAccountStatus(provider, accountId, status);
  }

  /**
   * Submit a verification code into an in-flight scoped Claude login. No-op
   * for providers whose flow has no paste-code step (Codex device-auth).
   */
  submitAccountCode(provider: AgentId, accountId: string, code: string): void {
    this.require(provider, accountId);
    const mgr = this.requireAuthManager(provider);
    if (typeof mgr.submitCode !== "function") {
      throw new Error(`${PROVIDER_LABEL[provider]} login has no code-submission step`);
    }
    mgr.submitCode(code);
  }

  /**
   * Remove a single account's on-disk credentials (scoped sign-out). Leaves
   * the account row itself in place; callers decide whether to also delete
   * the row. Marks the row `unavailable`.
   */
  signOutAccount(provider: AgentId, accountId: string): ProviderAccount {
    this.require(provider, accountId);
    const mgr = this.requireAuthManager(provider);
    const credentialDir = this.resolveCredentialRoot(provider, accountId);
    mgr.signOut({ credentialDir });
    return this.setAccountStatus(provider, accountId, "unavailable");
  }

  private requireAuthManager(provider: AgentId): AgentAuthManager {
    const mgr = this.authManagers?.get(provider);
    if (!mgr) throw new Error(`No auth manager wired for provider: ${provider}`);
    return mgr;
  }

  private migrateProviderDefault(provider: AgentId, accountId: string, label: string): void {
    if (this.list(provider).length > 0) return;

    const existingRelPaths = LEGACY_CREDENTIAL_PATHS[provider].filter((rel) =>
      fs.existsSync(path.join(this.credentialsDir, rel)),
    );
    if (existingRelPaths.length === 0) return;

    const accountRoot = this.resolveCredentialRoot(provider, accountId);
    fs.mkdirSync(accountRoot, { recursive: true });

    for (const rel of existingRelPaths) {
      const legacy = path.join(this.credentialsDir, rel);
      const dest = path.join(accountRoot, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest)) {
        try {
          fs.renameSync(legacy, dest);
        } catch {
          fs.cpSync(legacy, dest, { recursive: true, force: true });
          fs.rmSync(legacy, { recursive: true, force: true });
        }
      } else {
        fs.rmSync(legacy, { recursive: true, force: true });
      }
      this.ensureLegacyAlias(legacy, dest);
    }

    const now = Date.now();
    this.credentialStore.upsertProviderAccount({
      id: accountId,
      provider,
      label,
      isPrimary: true,
      status: "ready",
      capabilities: {
        source: "manual_default",
        refreshedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    });
  }

  private ensureLegacyAlias(legacyPath: string, targetPath: string): void {
    try {
      if (fs.existsSync(legacyPath)) return;
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      fs.symlinkSync(targetPath, legacyPath);
    } catch (err) {
      console.warn("[provider-accounts] failed to create legacy credential alias:", err);
    }
  }
}

export function providerAccountCredentialRoot(
  credentialsDir: string,
  provider: AgentId,
  accountId: string,
): string {
  return path.join(credentialsDir, PROVIDER_ACCOUNTS_SUBDIR, provider, accountId);
}

export function legacyCredentialPathsForProvider(provider: AgentId): readonly string[] {
  return LEGACY_CREDENTIAL_PATHS[provider];
}

export function providerDisplayLabel(provider: AgentId): string {
  return PROVIDER_LABEL[provider];
}

function normalizeLabel(label: string | undefined): string | null {
  const normalized = typeof label === "string" ? label.trim() : "";
  return normalized || null;
}

/**
 * Is this account out of quota right now, and until when?
 *
 * Returns the reset epoch-ms when exhausted, or `null` when the account is
 * usable. Two independent signals:
 *
 *   - the live quota snapshot's windows (`usedPct >= 100` with a reset still in
 *     the future), and
 *   - a persisted `exhaustedUntil` stamp, which is how a *hard* exhaustion
 *     reported mid-turn (req 7) keeps the account out of the running before any
 *     new snapshot has arrived.
 *
 * **Unknown quota counts as usable.** Claude only reports `usedPct` above a
 * warning threshold and Codex reports nothing until a turn has run, so treating
 * unknown as exhausted would lock out every freshly connected account. Erring
 * toward "try it" costs one failed turn; erring the other way makes the account
 * unusable forever.
 */
function exhaustedUntil(
  limits: { session?: unknown; weekly?: unknown } | undefined,
  account: ProviderAccount,
  now: number,
): number | null {
  const resets: number[] = [];
  if (typeof account.exhaustedUntil === "number" && account.exhaustedUntil > now) {
    resets.push(account.exhaustedUntil);
  }
  for (const key of ["session", "weekly"] as const) {
    const window = limits?.[key] as { usedPct: number | null; resetAt: string } | null | undefined;
    if (window === null || window === undefined) continue;
    if (window.usedPct === null || window.usedPct < 100) continue;
    const at = Date.parse(window.resetAt);
    // An exhausted window whose reset already passed is stale, not blocking.
    if (Number.isNaN(at)) resets.push(Number.POSITIVE_INFINITY);
    else if (at > now) resets.push(at);
  }
  if (resets.length === 0) return null;
  return Math.min(...resets);
}

/**
 * req 17 — can this account run the requested model? An account with no
 * capability snapshot yet is assumed capable: we have not learned otherwise,
 * and refusing on absent data would block every account until its first turn.
 */
function accountSupportsModel(account: ProviderAccount, model: string): boolean {
  const models = account.capabilities?.models;
  if (!models || models.length === 0) return true;
  return models.includes(model);
}

/**
 * docs/150 reqs 4–6 — has this account crossed either proactive cutoff?
 *
 * Separate from {@link exhaustedUntil} on purpose: that answers "can this
 * account run a turn at all", this answers "should it be the first choice".
 * Conflating them is the bug that would make a configured cutoff fail turns
 * that would otherwise have succeeded.
 *
 * A window with no reported percentage is NOT over its cutoff — the same
 * "unknown counts as usable" rule the exhaustion check uses, for the same
 * reason: Claude reports `usedPct` only above a warning threshold, so treating
 * silence as "past 90%" would demote every healthy account.
 */
function isOverCutoff(
  limits: { session?: unknown; weekly?: unknown } | undefined,
  cutoffs: FailoverCutoffs,
): boolean {
  for (const [key, cutoff] of [["session", cutoffs.session], ["weekly", cutoffs.weekly]] as const) {
    const window = limits?.[key] as { usedPct: number | null } | null | undefined;
    if (window?.usedPct === null || window?.usedPct === undefined) continue;
    if (window.usedPct >= cutoff) return true;
  }
  return false;
}
