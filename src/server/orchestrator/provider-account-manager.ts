import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AccountSelectionMode,
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

/**
 * Subdirectory under the credentials root holding one credential root per
 * provider account (`provider-accounts/<provider>/<accountId>`). Exported
 * because the docs/153 leak repair has to *discover* the account dirs a
 * session leaked into, rather than probe the one it can compute — see
 * `materializeLeakedSubtreeSymlinks` in `token-sync-manager.ts`.
 */
export const PROVIDER_ACCOUNTS_SUBDIR = "provider-accounts";

const PROVIDER_LABEL: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
};

/**
 * Pre-account credential locations at the credentials root, with the shape each
 * one has on disk. The shape is recorded because req 19's alias removal has to
 * leave a **real empty directory** behind for the directory-shaped ones — see
 * {@link ProviderAccountManager.removeLegacyAliases}.
 */
const LEGACY_CREDENTIAL_PATHS: Record<AgentId, readonly LegacyCredentialPath[]> = {
  claude: [{ rel: ".claude", kind: "dir" }, { rel: ".claude.json", kind: "file" }],
  codex: [{ rel: ".codex", kind: "dir" }],
};

interface LegacyCredentialPath {
  rel: string;
  kind: "dir" | "file";
}

/**
 * The files whose presence at the credentials root means the install genuinely
 * has pre-account credentials worth migrating.
 *
 * {@link LEGACY_CREDENTIAL_PATHS} answers "what do we move"; this answers
 * "should we move anything at all", and the two are deliberately different sets.
 * Existence of a legacy *path* is not evidence of credentials: `.claude.json` is
 * the CLI's user config, and `<credentialsDir>/.claude` is a directory anything
 * running with `HOME=/root` can create through the image-level symlink
 * (`docker/Dockerfile.prod`) — including the empty placeholder
 * {@link ProviderAccountManager.removeLegacyAliases} leaves behind. Migrating on
 * mere existence registered a `ready` account with an empty credential root,
 * which the router then preferred over the reserved API-key route (req 12's
 * guard only covers the failover direction) and the UI reported as connected.
 */
const LEGACY_CREDENTIAL_MARKERS: Record<AgentId, readonly string[]> = {
  claude: [
    path.join(".claude", ".credentials.json"),
    path.join(".claude", "credentials.json"),
    path.join(".claude", "auth.json"),
  ],
  codex: [path.join(".codex", "auth.json")],
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
    // req 19 — runs here rather than as separate boot wiring because this is
    // already the "bring stored accounts up to the current shape" entry point,
    // and both of its callers (boot, and the post-sign-in re-registration) want
    // the invariant. Idempotent, so the second call is free.
    this.backfillPriority();
    this.removeLegacyAliases();
  }

  /**
   * req 19 — retire the legacy alias symlinks at the credentials root.
   *
   * Migration used to leave `<credentialsDir>/.claude` (and friends) as a
   * symlink into the migrated default account, so anything still reading the
   * singleton path landed on real credentials. Every reader has since been
   * account-scoped, and the aliases were never harmless:
   *
   *   - they leak into session containers as *absolute* `/credentials/...`
   *     symlinks that resolve to a different physical file inside the
   *     subpath-mounted agent namespace than they do here, which is the entire
   *     reason docs/153's `materializeLeakedSubtreeSymlinks` repair exists; and
   *   - they make the flat root look like a credential source, so a session
   *     routed to a *reserved* route (`ANTHROPIC_API_KEY` / env OAuth) copied
   *     the migrated default's OAuth files in and ran on that subscription
   *     instead — the "never silently move between subscription and metered
   *     billing" hazard of req 12, in the direction nobody was watching.
   *
   * On an install that HAS a migrated account, a directory-shaped legacy path is
   * left as a real **empty** directory rather than removed outright:
   * `/root/.claude` and `/root/.codex` are image-level symlinks to these paths
   * (`docker/Dockerfile.prod`), and `mkdir` through a *dangling* symlink fails
   * with EEXIST — so a CLI invocation on a reserved route (which legitimately
   * runs with `HOME=/root`) would lose its config directory and fail in the same
   * quiet way session naming used to. File-shaped paths (`.claude.json`) need no
   * placeholder: a write through the dangling image symlink creates the target.
   *
   * The placeholder is owed only to an install with accounts. Writing it on a
   * never-signed-in install invents state nothing asked for, and
   * {@link migrateProviderDefault} read it back on the next boot as an account —
   * so the gate here is the account list, and the marker check there is the
   * second, independent guard for an install whose accounts were all deleted
   * after a placeholder had already been written.
   *
   * Only symlinks pointing into `provider-accounts/` are touched. A real file or
   * directory here belongs to an install whose migration has not run yet, and
   * deleting it would destroy the only copy of its credentials.
   */
  private removeLegacyAliases(): void {
    const accountsPrefix = path.join(this.credentialsDir, PROVIDER_ACCOUNTS_SUBDIR);
    for (const provider of ["claude", "codex"] as AgentId[]) {
      // The placeholder below is only owed to an install that HAS a migrated
      // account — the legacy path is where its credentials used to live. On a
      // never-signed-in install there is nothing to stand in for, and creating
      // the directory anyway invented on-disk state that the next boot's
      // migration then read back as an account. Leaving the path absent is
      // exactly the state such an install had before req 19.
      const migrated = this.list(provider).length > 0;
      for (const { rel, kind } of LEGACY_CREDENTIAL_PATHS[provider]) {
        const aliasPath = path.join(this.credentialsDir, rel);
        try {
          const stat = fs.lstatSync(aliasPath, { throwIfNoEntry: false });
          if (stat?.isSymbolicLink()) {
            const target = path.resolve(path.dirname(aliasPath), fs.readlinkSync(aliasPath));
            const insideAccounts =
              target === accountsPrefix || target.startsWith(`${accountsPrefix}${path.sep}`);
            if (!insideAccounts) continue;
            fs.unlinkSync(aliasPath);
          } else if (stat) {
            // Real file or directory: a pre-migration install, the empty
            // placeholder a previous boot left, or CLI config written through
            // the image-level `/root/.claude` symlink. Leave it alone — only
            // the first case holds credentials, and we cannot tell them apart
            // without reading, which {@link migrateProviderDefault} does.
            continue;
          }
          // Absent (alias just removed, or migration moved the subtree away).
          if (kind === "dir" && migrated) fs.mkdirSync(aliasPath, { recursive: true });
        } catch (err) {
          console.warn(`[provider-accounts] failed to retire legacy alias ${aliasPath}:`, err);
        }
      }
    }
  }

  /**
   * docs/150 req 2 — every account for a provider, **in the user's fallback
   * order**: ascending `priority`, ties broken by stored order so the sort is
   * stable.
   *
   * The order lives here rather than at each call site because this is the only
   * order an account list has. `reorder` writes `priority` and the router reads
   * it, but the *storage* array never moves (`upsertProviderAccount` replaces
   * in place), so a caller reading raw storage order sees the order the user
   * had before they ever touched the control. That is exactly what went wrong:
   * the reorder buttons wrote `priority` correctly — routing really did change
   * — while the response and the `provider_accounts` broadcast both carried
   * unsorted rows, so the list never moved and the control read as broken.
   *
   * Sorting at the source instead of at the ~8 wire boundaries means a new
   * broadcast site cannot reintroduce it by forgetting to sort.
   *
   * docs/150 req 19 — `isPrimary` is **derived here**, not read from disk.
   * "Primary" only ever meant "first in the fallback order": `makePrimary` is
   * implemented as a `reorder`, and `reorder` wrote `isPrimary: index === 0`.
   * Two fields encoding one fact is two fields that can disagree, so the
   * stored flag is now ignored on read and stamped from position instead. The
   * wire shape is unchanged, so the client still reads `account.isPrimary`.
   *
   * A row with no `priority` sorts after every row that has one, by stored
   * order. In practice there are none — {@link backfillPriority} runs at boot
   * and `create` always assigns one — but sorting them last beats treating a
   * missing value as 0 and silently promoting a legacy row to primary.
   */
  list(provider?: AgentId): ProviderAccount[] {
    if (!provider) {
      return (["claude", "codex"] as AgentId[]).flatMap((id) => this.list(id));
    }
    return this.credentialStore.listProviderAccounts(provider)
      .map((account, index) => ({ account, index }))
      .sort((a, b) => rankForOrder(a) - rankForOrder(b) || a.index - b.index)
      .map((entry, index) => ({ ...entry.account, isPrimary: index === 0 }));
  }

  get(provider: AgentId, accountId: string): ProviderAccount | undefined {
    // Through `list` so `isPrimary` is the derived value, not the stale stored
    // one — a caller must not see a different answer depending on which
    // accessor it happened to use.
    return this.list(provider).find((account) => account.id === accountId);
  }

  /** The account at the head of the fallback order, if any. */
  getPrimary(provider: AgentId): ProviderAccount | undefined {
    return this.list(provider)[0];
  }

  /**
   * docs/150 req 19 — give every stored row an explicit `priority`, once.
   *
   * Rows minted before `priority` existed (and the migrated `claude-default` /
   * `codex-default` rows) have none, which forced {@link list} to carry a
   * second ordering rule — "primary first, then stored order" — as a
   * compatibility branch. Backfilling from the order those rows *currently*
   * resolve to means the fallback order is unchanged for every existing
   * install, and the branch can go.
   *
   * Idempotent: a provider whose rows all have `priority` is not touched, so
   * this is a no-op on every boot after the first.
   */
  backfillPriority(): void {
    for (const provider of ["claude", "codex"] as AgentId[]) {
      const stored = this.credentialStore.listProviderAccounts(provider);
      if (stored.length === 0 || stored.every((a) => typeof a.priority === "number")) continue;
      // The order these rows resolve to TODAY, under the legacy rule, so the
      // backfill records what the user already had rather than reshuffling it.
      const primaryId = stored.find((a) => a.isPrimary)?.id ?? stored[0]?.id;
      const ordered = stored
        .map((account, index) => ({ account, index }))
        .sort((a, b) => legacyRank(a, primaryId) - legacyRank(b, primaryId) || a.index - b.index)
        .map((entry) => entry.account);
      ordered.forEach((account, index) => {
        this.credentialStore.upsertProviderAccount({ ...account, priority: index });
      });
    }
  }

  /**
   * docs/150 req 2 — kept as the name the router reads, so the intent is
   * explicit at the call site. {@link list} is already this order; the two are
   * deliberately the same list, because an account list has no other order.
   */
  accountsInSelectionOrder(provider: AgentId): ProviderAccount[] {
    return this.list(provider);
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
      // req 19 — `priority` is the whole record of the order. `isPrimary` used
      // to be written in step with position 0 here; it is derived on read now,
      // so writing it would just be a second copy that can drift.
      this.credentialStore.upsertProviderAccount({ ...account, priority: index });
    });
    return this.accountsInSelectionOrder(provider);
  }

  create(provider: AgentId, label?: string): ProviderAccount {
    const now = Date.now();
    const existing = this.list(provider);
    const supplied = normalizeLabel(label);
    const account: ProviderAccount = {
      id: `acct_${randomUUID()}`,
      provider,
      label: supplied ?? `${PROVIDER_LABEL[provider]} account ${existing.length + 1}`,
      // req 22 — a generated label is ShipIt's placeholder until the provider
      // reports who this account actually is; a supplied one is the user's.
      labelIsGenerated: supplied === null,
      // req 19 — derived from position on read; see `list`.
      isPrimary: false,
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
    // req 22 — once the user names a row, a later connect must not rename it
    // back to the provider's email.
    this.credentialStore.upsertProviderAccount({
      ...account,
      label: normalized,
      labelIsGenerated: false,
    });
    return this.require(provider, accountId);
  }

  // ---- Account identity (docs/150 req 22) ----

  /**
   * The row already holding this provider-reported account id, if any.
   *
   * `exceptAccountId` is what lets a stale row re-authenticate: a row signing
   * back into its *own* account necessarily matches itself, and treating that
   * as a duplicate would make the refusal a permanent lockout for exactly the
   * rows that most need to reconnect.
   */
  findByExternalId(
    provider: AgentId,
    externalId: string,
    exceptAccountId?: string,
  ): ProviderAccount | undefined {
    return this.list(provider).find(
      (account) => account.externalId === externalId && account.id !== exceptAccountId,
    );
  }

  /**
   * Record the identity a completed sign-in reported, and adopt the reported
   * email as the row's label while the label is still ShipIt's own.
   *
   * Idempotent — re-authenticating the same account rewrites the same values.
   */
  recordAccountIdentity(
    provider: AgentId,
    accountId: string,
    identity: { externalId: string; email?: string },
  ): ProviderAccount {
    const account = this.require(provider, accountId);
    const adoptLabel = account.labelIsGenerated === true && identity.email !== undefined;
    this.credentialStore.upsertProviderAccount({
      ...account,
      externalId: identity.externalId,
      ...(adoptLabel ? { label: identity.email! } : {}),
    });
    return this.require(provider, accountId);
  }

  /**
   * req 22 — undo a sign-in that turned out to be an account ShipIt already
   * has. Returns how the row was disposed of, for the message the user sees.
   *
   * The credentials the CLI just wrote are always destroyed: leaving them would
   * make the row a working duplicate, which is the outcome the refusal exists
   * to prevent. What happens to the *row* depends on whether it existed before
   * this sign-in:
   *
   *   - Never authenticated (`"deleted"`) — the row was created by this "Add
   *     account" click and has nothing else in it, so keeping it would leave
   *     a dead row the user has to clean up by hand.
   *   - Previously authenticated (`"reset"`) — the user signed a *different*
   *     account into a row they had been using. Deleting it would take its
   *     priority position and name with it, so the row stays, marked
   *     `auth_failed`, with its recorded identity intact.
   *
   * The matched row is not touched at all, in either case (req 22: ShipIt does
   * not quietly move credentials onto it either).
   */
  refuseDuplicateConnect(
    provider: AgentId,
    accountId: string,
    matched: ProviderAccount,
  ): "deleted" | "reset" {
    const account = this.require(provider, accountId);
    console.warn(
      `[provider-accounts] refusing ${provider} sign-in on ${accountId}: `
      + `already connected as "${matched.label}" (${matched.id})`,
    );
    if (account.externalId === undefined) {
      this.delete(provider, accountId);
      return "deleted";
    }
    fs.rmSync(this.resolveCredentialRoot(provider, accountId), { recursive: true, force: true });
    fs.mkdirSync(this.resolveCredentialRoot(provider, accountId), { recursive: true });
    this.setAccountStatus(provider, accountId, "auth_failed");
    return "reset";
  }

  /**
   * docs/150 req 21 — stamp an account as used, now.
   *
   * This is the write that makes `balanced` mean anything: `lastUsedAt` was
   * declared on `ProviderAccount` from the start but never written by anything,
   * so an LRU order over it would have been a no-op sort over a field that was
   * `undefined` everywhere.
   *
   * Called when a turn *resolves onto* an account, not when one is merely
   * *considered*. `selectAccountForTurn` is also used for probing (route
   * usability, the `selectRouteForTurn` wrapper), and stamping there would mark
   * accounts that never ran a thing.
   *
   * Deliberately called on **every** turn, not only the first turn that pins a
   * session. Balancing is about spreading load, so an account carrying active
   * work should keep sorting last for as long as that work continues — and a
   * pin-time-only stamp would let a long-lived busy session look idle forever.
   *
   * Cheap and best-effort: a missing account (deleted mid-turn) is a no-op
   * rather than a throw, because failing a turn over a bookkeeping write would
   * be a strictly worse outcome than a slightly stale sort key.
   */
  markAccountUsed(provider: AgentId, accountId: string): void {
    const account = this.get(provider, accountId);
    if (!account) return;
    // Strictly greater than every sibling's stamp, not simply `Date.now()`.
    // `Date.now()` is millisecond-granular, so two sessions pinning inside the
    // same millisecond would tie — and a tie falls back to priority order,
    // handing both to the same account. That is precisely the pile-up
    // `balanced` exists to prevent, and burst-safety is the reason LRU was
    // chosen over ranking by polled quota in the first place; a stamp that
    // cannot separate a burst would have quietly given up that advantage.
    //
    // The value stays a wall-clock timestamp in the ordinary case and only
    // runs ahead during a burst, by at most the burst's length in
    // milliseconds — it is a sort key, and nothing displays it.
    const peak = this.list(provider).reduce((max, a) => Math.max(max, a.lastUsedAt ?? 0), 0);
    this.credentialStore.upsertProviderAccount({
      ...account,
      lastUsedAt: Math.max(Date.now(), peak + 1),
    });
  }

  /**
   * Promote an account to the front of the fallback order. Kept as its own verb
   * (rather than "reorder with this id first") because it is the one-click
   * affordance the account rows already offer, and expressing it through
   * `reorder` means "primary" has exactly one definition: position 0.
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
   * list so a retry cannot land back on an account that just ran out (reqs 14,
   * 20), and
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
    const connected = orderForSelectionMode(
      this.accountsInSelectionOrder(provider).filter(
        (account) =>
          (account.status === "ready" || account.status === "authenticating") &&
          !exclude.has(account.id),
      ),
      this.credentialStore.getSelectionMode(provider),
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
    // the mode's own order keeps the choice stable rather than hunting for
    // whichever account is marginally least used — and under `balanced` that
    // order is already least-recently-used, so the tier degrades the same way
    // the tier above it does.
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

  /**
   * req 19 — sign out of a provider entirely: every connected account, plus any
   * pre-account credentials still sitting at the singleton path.
   *
   * The route used to delete the account *rows* and then call the unscoped
   * `signOut()`, which only ever cleared the singleton path. On a migrated
   * install that path was an alias into `<provider>-default`, so exactly one
   * account's credentials were erased; every account connected afterwards kept
   * live OAuth tokens on disk under `provider-accounts/`, unreachable from the
   * UI because its row was gone. "Sign out of Claude" left the tokens behind.
   *
   * Deleting through `delete()` per account is what fixes that — it ends an
   * in-flight login for the row, removes the credential root, and drops the
   * row. The unscoped `signOut()` still runs afterwards for installs that never
   * migrated (and, for Claude, to re-derive the singleton authenticated flag).
   *
   * **Not the whole sign-out.** This clears *source* credentials only; every
   * session pinned to one of these accounts holds its own copy, which is what
   * the CLI in its container actually reads. Call the service-layer
   * `signOutProvider` (`services/settings.ts`) instead — it carries the
   * running-turn guard, retires resident agent processes, revokes the
   * per-session copies, and then calls this (SHI-283).
   */
  signOutProvider(provider: AgentId): void {
    for (const account of this.list(provider)) {
      this.delete(provider, account.id);
    }
    this.requireAuthManager(provider).signOut();
  }

  private requireAuthManager(provider: AgentId): AgentAuthManager {
    const mgr = this.authManagers?.get(provider);
    if (!mgr) throw new Error(`No auth manager wired for provider: ${provider}`);
    return mgr;
  }

  private migrateProviderDefault(provider: AgentId, accountId: string, label: string): void {
    if (this.list(provider).length > 0) return;

    // The legacy migration belongs to the ORCHESTRATOR's credentials volume.
    // Inside a session container `/credentials` is that session's own agent
    // home (`container-lifecycle.ts` mounts `<root>/sessions/<id>` there), so
    // the exact same code path would "migrate" the live home of the CLI that
    // is running right now — see {@link isSessionContainerCredentialRoot}.
    if (isSessionContainerCredentialRoot()) {
      console.warn(
        `[provider-accounts] skipping ${provider} legacy migration: running inside session `
          + `container ${process.env.SHIPIT_SESSION_ID}, where ${this.credentialsDir} is the `
          + `live agent home, not the orchestrator credentials volume.`,
      );
      return;
    }

    // req 19 — gate on real credentials, not on a legacy path merely existing.
    // See {@link LEGACY_CREDENTIAL_MARKERS}: an empty `.claude` directory (the
    // alias-retirement placeholder, or anything that ran with `HOME=/root`) is
    // not an account, and registering it as one produced a `ready` row with no
    // credentials behind it.
    const hasCredentials = LEGACY_CREDENTIAL_MARKERS[provider].some((rel) =>
      isNonEmptyFile(path.join(this.credentialsDir, rel)),
    );
    if (!hasCredentials) return;

    // Credentials confirmed — now move everything the legacy layout owns,
    // including the CLI config (`.claude.json`) that is not itself a credential.
    const existingRelPaths = LEGACY_CREDENTIAL_PATHS[provider].filter((entry) =>
      fs.existsSync(path.join(this.credentialsDir, entry.rel)),
    );
    if (existingRelPaths.length === 0) return;

    const accountRoot = this.resolveCredentialRoot(provider, accountId);
    fs.mkdirSync(accountRoot, { recursive: true });

    // Copy-then-verify, never rename. A `renameSync` here is a MOVE with no
    // intermediate state: the instant it returns, the only copy of the
    // credential (and, for `.claude`, the conversation history beside it) lives
    // at the new path. If the dir it was handed turns out to be someone's live
    // agent home, that is unrecoverable and silent. Copying first means a
    // mistake costs disk, not credentials; the source is removed only after the
    // copy is confirmed present at the destination.
    for (const { rel } of existingRelPaths) {
      const legacy = path.join(this.credentialsDir, rel);
      const dest = path.join(accountRoot, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest)) {
        try {
          fs.cpSync(legacy, dest, { recursive: true, force: true, dereference: true });
        } catch (err) {
          // Copy failed — leave the legacy path exactly as it was and abandon
          // the migration rather than register an account with a half-copied
          // credential root behind it.
          console.error(
            `[provider-accounts] ${provider} legacy migration failed copying ${legacy}: ${
              err instanceof Error ? err.message : String(err)
            }. Leaving credentials in place.`,
          );
          return;
        }
      }
      if (!fs.existsSync(dest)) {
        console.error(
          `[provider-accounts] ${provider} legacy migration: ${dest} missing after copy; `
            + `leaving ${legacy} in place.`,
        );
        return;
      }
      fs.rmSync(legacy, { recursive: true, force: true });
    }

    const now = Date.now();
    this.credentialStore.upsertProviderAccount({
      id: accountId,
      provider,
      label,
      // req 19 — the migrated row is the only account at migration time, so it
      // leads the order. `isPrimary` is derived from that on read.
      isPrimary: false,
      priority: 0,
      status: "ready",
      capabilities: {
        source: "manual_default",
        refreshedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    });
  }

}

export function providerAccountCredentialRoot(
  credentialsDir: string,
  provider: AgentId,
  accountId: string,
): string {
  return path.join(credentialsDir, PROVIDER_ACCOUNTS_SUBDIR, provider, accountId);
}

export function providerDisplayLabel(provider: AgentId): string {
  return PROVIDER_LABEL[provider];
}

function normalizeLabel(label: string | undefined): string | null {
  const normalized = typeof label === "string" ? label.trim() : "";
  return normalized || null;
}

/**
 * True iff `filePath` is a regular file with content. Used to decide whether a
 * legacy credential marker is real: a zero-byte file is what a crashed write or
 * a `touch` leaves, and it carries no token, so it must not trigger migration.
 */
/**
 * Are we running inside a session container, where `/credentials` is a single
 * session's live agent home rather than the orchestrator's credentials volume?
 *
 * `SHIPIT_SESSION_ID` is set on every session container (`container-lifecycle
 * .ts`) and on nothing else — the orchestrator process never has it. That makes
 * it the cheap, exact answer to "is the dir I am about to rewrite someone's
 * running home?", which no amount of inspecting the dir's *contents* can give:
 * a session home and a pre-account orchestrator volume have the same shape
 * (`.claude/`, `.claude.json`), which is precisely why the migration mistook
 * one for the other.
 */
export function isSessionContainerCredentialRoot(): boolean {
  return (process.env.SHIPIT_SESSION_ID ?? "") !== "";
}

function isNonEmptyFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    return stat !== undefined && stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
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
/**
 * docs/150 req 21 — reorder the eligible accounts according to the provider's
 * selection mode. Called once, before the eligibility walk, so every tier of
 * that walk (under-cutoff, then over-cutoff) inherits the same order.
 *
 * `strict` is the identity: the caller already handed us the user's priority
 * order, which under that mode *is* the preference.
 *
 * `balanced` sorts least-recently-used first. Two reasons that beats ranking by
 * current quota usage, which looks like the more direct read of "drain at a
 * comparable rate":
 *
 *   - Quota is **polled**, so a burst of new sessions would all see the same
 *     stale snapshot and all pin to whichever account looked least used —
 *     precisely the pile-up `balanced` exists to avoid. `lastUsedAt` is stamped
 *     synchronously when a turn resolves onto an account, so the second session
 *     in a burst already sees the first one's effect.
 *   - Ranking accounts by *known* quota against accounts whose quota is unknown
 *     is a genuinely open question (see the checklist's "ranking below
 *     known-healthy quota is still open"). Deciding it as a side effect of this
 *     mode would settle it by accident.
 *
 * `Array.prototype.sort` is stable, so accounts that tie — including the whole
 * list on an install where nothing has run yet — keep the user's priority order.
 * That makes `balanced` degrade to `strict` rather than to something arbitrary.
 */
export function orderForSelectionMode(
  accounts: ProviderAccount[],
  mode: AccountSelectionMode,
): ProviderAccount[] {
  if (mode !== "balanced") return accounts;
  return [...accounts].sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
}

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
/**
 * docs/150 req 2 — the fallback order is `priority`, ascending. A row without
 * one sorts last (see {@link ProviderAccountManager.list}); `backfillPriority`
 * means there shouldn't be any.
 */
function rankForOrder(entry: { account: ProviderAccount }): number {
  return entry.account.priority ?? Number.POSITIVE_INFINITY;
}

/**
 * The pre-`priority` ordering rule — primary first, then stored order — kept
 * ONLY to seed {@link ProviderAccountManager.backfillPriority}, so the
 * one-time backfill records the order an existing install already had instead
 * of reshuffling it. Nothing on the read path uses this.
 */
function legacyRank(
  entry: { account: ProviderAccount; index: number },
  primaryId: string | undefined,
): number {
  if (typeof entry.account.priority === "number") return entry.account.priority;
  if (entry.account.id === primaryId) return Number.NEGATIVE_INFINITY;
  return entry.index;
}
