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
 * Why an account could not be selected (docs/150 req 13). A bare `null` could
 * not express either of these, and req 13 is specifically about *telling the
 * user which one happened* — "everything is exhausted until 14:30" and "nothing
 * is connected" are different problems with different fixes.
 *
 * Model eligibility is deliberately absent: routing around an account that
 * cannot run the requested model is a non-goal (see `plan.md` — "Non-goal:
 * routing around model capability"). Mixing accounts with different model
 * access is the user's choice to manage, and the provider's own error is the
 * clear signal.
 */
export type AccountSelectionFailure =
  /** Nothing is connected (or everything needs re-auth). */
  | { reason: "auth_required" }
  /**
   * Every connected account has a window at 100%. `earliestResetAt` is the
   * soonest any of them frees up, so req 13 can say when — `null` only if no
   * exhausted window carried a parseable reset time.
   */
  | { reason: "all_exhausted"; earliestResetAt: string | null };

export type AccountSelection =
  | { ok: true; route: ProviderRoute }
  | ({ ok: false } & AccountSelectionFailure);

export interface SelectAccountOptions {
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
   * docs/150 req 2 — this provider's accounts in the user's fallback order:
   * ascending `priority`, ties broken by stored order so the sort is stable.
   *
   * Rows written before `priority` existed have none. Those keep exactly the
   * previous behaviour — primary first, then stored order — so an install that
   * has never used the reorder control sees no change in which account its
   * turns run on. Once the user reorders, every row carries an explicit value
   * and this mixed state is gone.
   */
  accountsInSelectionOrder(provider: AgentId): ProviderAccount[] {
    const accounts = this.list(provider);
    const primaryId = this.getPrimary(provider)?.id;
    return accounts
      .map((account, index) => ({ account, index }))
      .sort((a, b) => rankForOrder(a, primaryId) - rankForOrder(b, primaryId) || a.index - b.index)
      .map((entry) => entry.account);
  }

  /**
   * docs/150 req 2 — persist an explicit fallback order.
   *
   * Takes the complete list rather than a move-one-account verb: an ordering is
   * only meaningful as a whole, and requiring the full set makes a stale client
   * (one that never saw an account added in another tab) fail loudly instead of
   * silently dropping that account to the end.
   */
  reorder(provider: AgentId, orderedIds: readonly string[]): ProviderAccount[] {
    const accounts = this.list(provider);
    const known = new Set(accounts.map((account) => account.id));
    const requested = new Set(orderedIds);
    if (requested.size !== orderedIds.length) {
      throw new Error("Provider account order contains duplicates");
    }
    if (requested.size !== known.size || orderedIds.some((id) => !known.has(id))) {
      throw new Error("Provider account order must list every account for this provider exactly once");
    }
    orderedIds.forEach((id, index) => {
      const account = accounts.find((a) => a.id === id)!;
      // `isPrimary` stays in step with position 0 so the badge, the disabled
      // "make primary" button, and the order can't disagree about which account
      // leads. `upsertProviderAccount` clears the flag from the others.
      this.credentialStore.upsertProviderAccount({ ...account, priority: index, isPrimary: index === 0 });
    });
    return this.accountsInSelectionOrder(provider);
  }

  create(provider: AgentId, label?: string): ProviderAccount {
    const now = Date.now();
    const existing = this.list(provider);
    const account: ProviderAccount = {
      id: `acct_${randomUUID()}`,
      provider,
      label: normalizeLabel(label) ?? `${PROVIDER_LABEL[provider]} account ${existing.length + 1}`,
      isPrimary: existing.length === 0,
      // req 2 — a newly connected account APPENDS to the fallback order. If it
      // were inserted anywhere else, connecting an account would silently
      // change which subscription existing work runs on.
      priority: existing.reduce((max, a) => Math.max(max, a.priority ?? -1), -1) + 1,
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

  /**
   * Promote an account to the front of the fallback order. Kept as its own verb
   * (rather than "reorder with this id first") because it is the one-click
   * affordance the account rows already offer, and expressing it through
   * `reorder` keeps `priority` and `isPrimary` from drifting apart.
   */
  makePrimary(provider: AgentId, accountId: string): ProviderAccount {
    this.require(provider, accountId);
    const rest = this.accountsInSelectionOrder(provider)
      .map((account) => account.id)
      .filter((id) => id !== accountId);
    this.reorder(provider, [accountId, ...rest]);
    return this.require(provider, accountId);
  }

  delete(provider: AgentId, accountId: string): void {
    this.require(provider, accountId);
    // Deleting the row that owns the in-flight login must also end that login.
    // Otherwise the CLI keeps running against a credential root we are about to
    // remove, and the manager keeps reporting the deleted account as the active
    // scope — which `startAccountAuth` reads, so every later sign-in for this
    // provider is refused by a row that no longer exists and therefore has no
    // Cancel button. The provider would be locked out of sign-in until the
    // process exited or the orchestrator restarted.
    const mgr = this.authManagers?.get(provider);
    if (mgr?.getActiveAccountId() === accountId) mgr.cancel();
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

    // docs/150 reqs 4–6 — three tiers, not two. An account past its cutoff is
    // still perfectly capable of running the turn; it has just stopped being
    // the *first* choice. Collapsing "past cutoff" into "exhausted" would make
    // a 90% setting strictly worse than no failover at all: once every account
    // crossed 90%, every turn would fail with `all_exhausted` while ten percent
    // of quota sat unused on each one.
    const cutoffs = this.credentialStore.getFailoverCutoffs(provider);
    const overCutoff: ProviderAccount[] = [];
    const exhaustedResets: number[] = [];
    for (const account of connected) {
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
  isRouteUsableForTurn(provider: AgentId, route: ProviderRoute): boolean {
    if (route.kind !== "account") return true;
    const account = this.get(provider, route.id);
    if (!account) return false;
    if (account.status !== "ready" && account.status !== "authenticating") return false;
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
    // There is ONE login process per provider, so two rows cannot sign in at
    // once. Without this guard the second `Add account` marked its own row
    // `authenticating` and then either inherited the first row's challenge
    // (Codex replays the cached device code) or killed the first row's flow
    // while leaving that row stuck on `authenticating` (Claude). Either way one
    // row showed a state that did not match any real process. Refusing is the
    // honest outcome: the user finishes or cancels the other sign-in first.
    const inFlight = mgr.getActiveAccountId();
    if (inFlight && inFlight !== accountId) {
      const label = this.get(provider, inFlight)?.label ?? inFlight;
      throw new Error(
        `${PROVIDER_LABEL[provider]} is already signing in on "${label}". Finish or cancel that sign-in first.`,
      );
    }
    const credentialDir = this.resolveCredentialRoot(provider, accountId);
    fs.mkdirSync(credentialDir, { recursive: true });
    const account = this.setAccountStatus(provider, accountId, "authenticating");
    try {
      mgr.start({ accountId, credentialDir });
    } catch (err) {
      // A failed spawn must not leave the row claiming to be signing in: with
      // the guard above, a phantom `authenticating` row blocks every other
      // account's sign-in, and the caller only sees an error string. Put the
      // row back and release any scope the manager took before throwing.
      this.setAccountStatus(provider, accountId, "unavailable");
      try { mgr.cancel(); } catch { /* best effort — the flow may never have started */ }
      throw err;
    }
    return account;
  }

  /**
   * Cancel an in-flight scoped login. Resets the row's status to `ready` when
   * the account already has on-disk credentials, otherwise `unavailable`.
   */
  cancelAccountAuth(provider: AgentId, accountId: string): ProviderAccount {
    this.require(provider, accountId);
    const mgr = this.requireAuthManager(provider);
    // Only kill the CLI if it is *this* account's flow. An unconditional
    // cancel let one row's Cancel button abort another row's sign-in — and
    // since the status reset below only touches the row that was clicked, the
    // aborted row would have sat on `authenticating` forever. Resetting this
    // row's status still happens either way: the row is not signing in now,
    // whatever the process is doing.
    const inFlight = mgr.getActiveAccountId();
    if (!inFlight || inFlight === accountId) mgr.cancel();
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
    // A pasted authorization code is bound to the challenge that issued it, so
    // it may only go to the flow this row owns. `null` is a refusal too, not a
    // pass: it means no flow is running (timed out, cancelled, or lost to a
    // restart), and the manager would otherwise swallow the code with a log
    // line while the endpoint answered 200 — the user waits on a sign-in that
    // silently went nowhere.
    const inFlight = mgr.getActiveAccountId();
    if (inFlight !== accountId) {
      const label = inFlight ? this.get(provider, inFlight)?.label ?? inFlight : null;
      throw new Error(
        label
          ? `${PROVIDER_LABEL[provider]} is already signing in on "${label}". Finish or cancel that sign-in first.`
          : `That ${PROVIDER_LABEL[provider]} sign-in is no longer running. Start it again before pasting the code.`,
      );
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

/**
 * Sort key for {@link ProviderAccountManager.accountsInSelectionOrder}.
 * An explicit `priority` wins; without one, the legacy primary leads and
 * everything else falls back to stored order.
 */
function rankForOrder(
  entry: { account: ProviderAccount; index: number },
  primaryId: string | undefined,
): number {
  if (typeof entry.account.priority === "number") return entry.account.priority;
  if (entry.account.id === primaryId) return Number.NEGATIVE_INFINITY;
  return entry.index;
}
