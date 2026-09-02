import type { LoginIntegrationId } from "../shared/catalogue/types.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AccountSelectionMode,
  AgentId,
  CredentialRoute,
  CredentialStatus,
  FailoverCutoffs,
  ProviderRouteKind,
  SubscriptionLimits,
  SubscriptionLimitsMap,
} from "../shared/types.js";
import type { CredentialStore } from "./credential-store.js";
import type { AgentAuthManager } from "./agent-auth-manager.js";
import {
  allServices,
  harnessForNativeService,
  modeCredentialFor,
  loginIntegrationForService,
  nativeServiceForHarness,
} from "../shared/catalogue/index.js";
import { credentialModeKey, orderCredentialRoutes, refusalBlockedUntil } from "../shared/types/domain-types/credential-route.js";
import { subscriptionWindowIsCurrent } from "../shared/types/usage-limits-types.js";
import { probeNestedString } from "./agents/agent-auth-base.js";

/**
 * The billing mode an account-delivered credential always has.
 *
 * A login account IS a subscription — that is what the login buys — so every
 * question this manager asks belongs to one `(service, "sub")` group. Written
 * as a constant rather than a parameter because a *second* value here would be
 * a claim nothing in the catalogue makes: no mode of kind `key` declares a
 * `via: "account"` credential, and req 12 says the two modes never mix anyway.
 */
const ACCOUNT_BILLING_MODE = "sub" as const;

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
  opencode: "OpenCode",
  grok: "Grok Build",
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
  // OpenCode is new in docs/268 — no install ever held pre-account OpenCode
  // credentials, so there is nothing to migrate and nothing to alias.
  opencode: [],
  // Same for Grok Build (docs/274): no install predates its row, so there are
  // no pre-account credentials to migrate.
  grok: [],
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
  opencode: [],
  grok: [],
};

export interface ProviderRoute {
  kind: ProviderRouteKind;
  id: string;
}

/**
 * The env-delivered credentials a **service** may have, in the order they are
 * preferred, with the route id each has always been known by.
 *
 * Keyed by service rather than by harness (planning#342) — the variables belong
 * to a vendor's API, not to a CLI. The order is Anthropic's alone and is load
 * bearing: `ANTHROPIC_AUTH_TOKEN` is a *subscription* delivered as a string, so
 * it outranks the metered `ANTHROPIC_API_KEY` for exactly req 12's reason.
 *
 * The ids are ShipIt's historical ones rather than anything derived. A session
 * row already holds them, so re-deriving would orphan every session pinned
 * before docs/252 (`service-routing.ts` states the same rule for the stored
 * side, and `envRouteIdFor` is its reader).
 */
const RESERVED_ENV_ROUTES: Record<string, readonly { env: string; id: string }[]> = {
  anthropic: [
    { env: "ANTHROPIC_AUTH_TOKEN", id: "claude-env-oauth" },
    { env: "ANTHROPIC_API_KEY", id: "claude-api-key" },
  ],
  openai: [{ env: "OPENAI_API_KEY", id: "codex-api-key" }],
};

/**
 * The `(service, billing mode)` group a set of accounts routes within, as a
 * tuple so call sites can spread it into the store's two-argument accessors
 * without naming the pair twice.
 *
 * Order, spreading and the failover cutoffs are all answers to "which of these
 * credentials next?", and req 12 keeps that question inside one subscription
 * mode. Nothing here consults a `key` mode's settings, and nothing should —
 * keys do not fail over, so there is no group.
 */
function routingSettingsKeyFor(serviceId: string): [string, typeof ACCOUNT_BILLING_MODE] {
  return [serviceId, ACCOUNT_BILLING_MODE];
}

/**
 * Every catalogue service whose subscription is delivered by a **login
 * account**, in catalogue order.
 *
 * Read from the catalogue rather than written down as `["anthropic", "openai"]`
 * so a service that grows a login flow is picked up by declaring one, which is
 * the whole point of the catalogue. Today it resolves to exactly those two, in
 * that order — which is the order the pre-planning#342 code produced by walking
 * `["claude", "codex"]`, so the unnarrowed {@link ProviderAccountManager.list}
 * keeps returning accounts in the order every wire reader already sees.
 */
function accountServiceIds(): string[] {
  return allServices()
    .filter((service) => modeCredentialFor(service.id, ACCOUNT_BILLING_MODE, "account") !== undefined)
    .map((service) => service.id);
}

/**
 * The harness whose credential root belongs to this service — the axis that is
 * genuinely still per-harness.
 *
 * The auth MANAGER is no longer among them: login flows are keyed by
 * `LoginIntegrationId` (see `AgentAuthManager`). What remains harness-keyed is
 * where the credentials land, because the
 * credentials it writes land under `provider-accounts/<harness>/<id>`, so these
 * cannot be keyed by service without moving every install's credentials on
 * disk. Everything *else* — which credential a turn takes, the order, the
 * cutoffs, the benching — is keyed by `(service, billing mode)` and never asks
 * this question.
 */
function harnessFor(serviceId: string): AgentId | undefined {
  return harnessForNativeService(serviceId);
}

function requireHarness(serviceId: string): AgentId {
  const harness = harnessFor(serviceId);
  if (!harness) throw new Error(`No account-backed harness for service: ${serviceId}`);
  return harness;
}

/**
 * The service a harness's login accounts live under — the bridge for the
 * callers that legitimately hold only an `AgentId`: an auth event from a CLI, a
 * session's pinned harness, a `shipit agent run` naming a backend.
 *
 * Exported so those conversions are one named step rather than a
 * `nativeServiceForHarness(...) ?? something` improvised per call site, each
 * free to pick a different fallback. A harness with no catalogue vendor has no
 * account rows at all, so the empty string — which matches no service — makes
 * every lookup answer "none" instead of throwing or, worse, matching.
 */
export function accountServiceForHarness(provider: AgentId): string {
  return nativeServiceForHarness(provider) ?? "";
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
 * Why an account could not be selected (docs/150-multiple-provider-subscriptions req 13). A bare `null` could
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
   * Routes already tried and failed this turn. The attempt loop (docs/260
   * req 6) passes every refused route so a retry cannot pick it again.
   */
  exclude?: readonly string[];
  /**
   * docs/260-turn-level-account-routing req 8 — the credential route backing the session's resident CLI
   * process, when one is alive (an account id, or a stored string-credential
   * id). Under `balanced` the mode spreads **sessions**, not turns: while this
   * credential is eligible, unblocked, and under its cutoff it is chosen
   * outright, because least-recently-used ordering would otherwise alternate
   * a two-credential install every turn and restart the resident process each
   * time. Under `strict` this is ignored — the strategy is absolute and the
   * session moves back the turn a better credential recovers.
   */
  residentRouteId?: string;
  /**
   * docs/260-turn-level-account-routing req 12 — set by callers that will actually ATTEMPT the result
   * (the turn's attempt loop). When every non-excluded account is
   * refusal-blocked, an optimistic selection returns the best blocked one
   * instead of failing, so a resend after an all-refused turn re-tries every
   * account. Non-optimistic callers (voice, naming — work that cannot
   * attempt) get the `all_exhausted` failure and simply don't run: req 12
   * names the user's resend as the force-retry boundary, and background work
   * is not that resend.
   */
  optimistic?: boolean;
}

/**
 * App-scoped registry and turn router for **account-delivered** credentials:
 * the docs/150 login accounts, which are `via: "account"` rows of a service's
 * subscription mode. It owns their storage paths, the legacy default-account
 * migration, the account-scoped auth flows, and the quota-aware walk that picks
 * which of them a turn runs on.
 *
 * ## Two axes, and which one a method takes (planning#342)
 *
 * docs/252's premise is that `AgentId` conflated three things, one of which is
 * "which credential authenticates this". This manager used to be keyed by it
 * throughout and read an account-shaped projection over `CredentialRoute`;
 * planning#342 deleted the projection and split the axes:
 *
 *   - **`serviceId: string`** — every question about a credential *row*: which
 *     ones exist, their order, which one a turn takes, benching, cutoffs,
 *     status. The group is always `(serviceId, "sub")`; see
 *     {@link ACCOUNT_BILLING_MODE}.
 *   - **`provider: AgentId`** — only where a *harness* is genuinely the subject:
 *     the on-disk credential root (`provider-accounts/<harness>/…`), the login
 *     flow (one `AgentAuthManager` per CLI), and "does this harness have any
 *     credential of its own vendor's".
 *
 * Both are strings at runtime, so the discipline is in the types: the harness
 * parameters are the `AgentId` union, which a service id cannot satisfy. The
 * other direction is unchecked — `list("claude")` compiles and answers `[]` —
 * and {@link ProviderAccountManager.list} says so where a reader will meet it.
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
  private authManagers: Map<LoginIntegrationId, AgentAuthManager> | null = null;

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
  /**
   * The quota snapshots of one `(service, billing mode)`, keyed by route id.
   *
   * Public because the STRING-delivered twin of the account walk needs exactly
   * the same map (`stringSelectionFor`). Quota is recorded per route and gated
   * only on the mode being a subscription (`bootstrap-managers.ts` →
   * `credentialOwnerForRouteId`), so a supplied Anthropic plan token reports
   * quota just as an account does — the map has never been accounts-only, only
   * its readers were.
   *
   * Lives here rather than being threaded through `SelectRouteDeps` from six
   * call sites because this manager already holds the accessor, and a
   * per-call-site parameter is a parameter a site can forget: absence would
   * read as "no quota", silently dropping a failover tier.
   */
  subscriptionLimitsFor(
    serviceId: string,
    billingMode: "sub" | "key",
  ): Record<string, SubscriptionLimits> {
    return this.getSubscriptionLimits?.()?.[credentialModeKey(serviceId, billingMode)] ?? {};
  }

  attachSubscriptionLimits(getSubscriptionLimits: () => SubscriptionLimitsMap): void {
    this.getSubscriptionLimits = getSubscriptionLimits;
  }

  /**
   * Wire the per-provider auth managers so this manager can start/cancel
   * account-scoped login flows (docs/150). Called once from `index.ts` after
   * `buildAgentRuntime`.
   */
  attachAuthManagers(authManagers: Map<LoginIntegrationId, AgentAuthManager>): void {
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
   * Quarantine Claude rows whose account roots contain the exact same OAuth
   * access token. Two distinct connected accounts cannot legitimately share
   * one bearer; this means a stale session subtree was written back to the
   * wrong account root. There is no safe way to infer which label owns the
   * token, so every row in the duplicate group must be reconnected.
   *
   * Returns opaque route-id groups for diagnostics. Token material never
   * leaves this method and is never logged.
   */
  quarantineDuplicateClaudeCredentials(): string[][] {
    const byToken = new Map<string, string[]>();
    for (const account of this.list("anthropic")) {
      const root = this.resolveCredentialRoot("claude", account.id);
      const token = LEGACY_CREDENTIAL_MARKERS.claude
        .map((rel) => readClaudeAccessToken(path.join(root, rel)))
        .find((candidate): candidate is string => candidate !== null);
      if (!token) continue;
      const ids = byToken.get(token) ?? [];
      ids.push(account.id);
      byToken.set(token, ids);
    }

    const duplicates = [...byToken.values()].filter((ids) => ids.length > 1);
    for (const ids of duplicates) {
      for (const id of ids) this.setAccountStatus("anthropic", id, "auth_failed");
    }
    return duplicates;
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
      const serviceId = nativeServiceForHarness(provider);
      const migrated = serviceId !== undefined && this.list(serviceId).length > 0;
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
   * docs/150-multiple-provider-subscriptions req 2 — every account-delivered credential of `serviceId`'s
   * subscription, **in the user's fallback order**: ascending `priority`, ties
   * broken by stored order so the sort is stable.
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
   * docs/150-multiple-provider-subscriptions req 19 — `isPrimary` is **derived here**, not read from disk.
   * "Primary" only ever meant "first in the fallback order": every writer
   * stores `false`, and `reorder` used to stamp `isPrimary: index === 0`. Two
   * fields encoding one fact is two fields that can disagree, so the stored
   * flag is ignored on read and stamped from position instead.
   *
   * docs/252 req 21 finished the thought and deleted the *setter*. `makePrimary`
   * was `reorder([this, …rest])` behind a button beside the reorder controls —
   * one fact with two affordances — and dragging a row to the top now says the
   * same thing. The derived field stays on the wire; nothing in the UI reads it.
   *
   * A row with no `priority` sorts after every row that has one, by stored
   * order. In practice there are none — {@link backfillPriority} runs at boot
   * and `create` always assigns one — but sorting them last beats treating a
   * missing value as 0 and silently promoting a legacy row to primary.
   *
   * **`serviceId` is a catalogue service, not a harness** (planning#342). Both
   * are bare strings, so `list("claude")` compiles — and answers `[]`, because
   * no service has that id. The manager's own axis is the service; the harness
   * survives only where a login flow or a credential root is involved, and
   * those parameters are typed `AgentId` so the two cannot be transposed.
   */
  list(serviceId?: string): CredentialRoute[] {
    if (serviceId === undefined) {
      return accountServiceIds().flatMap((id) => this.list(id));
    }
    return orderCredentialRoutes(
      this.credentialStore
        .listCredentialRoutes(serviceId, ACCOUNT_BILLING_MODE)
        .filter((route) => route.via === "account"),
    );
  }

  get(serviceId: string, routeId: string): CredentialRoute | undefined {
    // Through `list` so `isPrimary` is the derived value, not the stale stored
    // one — a caller must not see a different answer depending on which
    // accessor it happened to use.
    return this.list(serviceId).find((route) => route.id === routeId);
  }

  /** The account at the head of the fallback order, if any. */
  getPrimary(serviceId: string): CredentialRoute | undefined {
    return this.list(serviceId)[0];
  }

  /**
   * docs/150-multiple-provider-subscriptions req 19 — give every stored row an explicit `priority`, once.
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
    for (const serviceId of accountServiceIds()) {
      const stored = this.credentialStore
        .listCredentialRoutes(serviceId, ACCOUNT_BILLING_MODE)
        .filter((route) => route.via === "account");
      if (stored.length === 0 || stored.every((a) => typeof a.priority === "number")) continue;
      // The order these rows resolve to TODAY, under the legacy rule, so the
      // backfill records what the user already had rather than reshuffling it.
      const primaryId = stored.find((a) => a.isPrimary)?.id ?? stored[0]?.id;
      const ordered = stored
        .map((route, index) => ({ route, index }))
        .sort((a, b) => legacyRank(a, primaryId) - legacyRank(b, primaryId) || a.index - b.index)
        .map((entry) => entry.route);
      ordered.forEach((route, index) => {
        this.credentialStore.upsertCredentialRoute({ ...route, priority: index });
      });
    }
  }

  /**
   * docs/150-multiple-provider-subscriptions req 2 — kept as the name the router reads, so the intent is
   * explicit at the call site. {@link list} is already this order; the two are
   * deliberately the same list, because an account list has no other order.
   */
  accountsInSelectionOrder(serviceId: string): CredentialRoute[] {
    return this.list(serviceId);
  }

  /**
   * docs/150-multiple-provider-subscriptions req 2 — persist an explicit fallback order.
   *
   * Takes the complete list rather than a move-one-account verb: an ordering is
   * only meaningful as a whole, and requiring the full set makes a stale client
   * (one that never saw an account added in another tab) fail loudly instead of
   * silently dropping that account to the end.
   */
  reorder(serviceId: string, orderedIds: readonly string[]): CredentialRoute[] {
    const accounts = this.list(serviceId);
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
      this.credentialStore.upsertCredentialRoute({ ...account, priority: index });
    });
    return this.accountsInSelectionOrder(serviceId);
  }

  create(serviceId: string, label?: string): CredentialRoute {
    const provider = requireHarness(serviceId);
    const now = Date.now();
    const existing = this.list(serviceId);
    const supplied = normalizeLabel(label);
    const account: CredentialRoute = {
      id: `acct_${randomUUID()}`,
      serviceId,
      billingMode: ACCOUNT_BILLING_MODE,
      via: "account",
      label: supplied ?? generatedAccountLabel(provider, existing),
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
    this.credentialStore.upsertCredentialRoute(account);
    return this.get(serviceId, account.id) ?? account;
  }

  rename(serviceId: string, accountId: string, label: string): CredentialRoute {
    const account = this.require(serviceId, accountId);
    const normalized = normalizeLabel(label);
    if (!normalized) throw new Error("Provider account label cannot be empty");
    if (normalized.length > 120) throw new Error("Provider account label is too long (max 120 characters)");
    // req 22 — once the user names a row, a later connect must not rename it
    // back to the provider's email.
    this.credentialStore.upsertCredentialRoute({
      ...account,
      label: normalized,
      labelIsGenerated: false,
    });
    return this.require(serviceId, accountId);
  }

  // ---- Account identity (docs/150-multiple-provider-subscriptions req 22) ----

  /**
   * The row already holding this provider-reported account id, if any.
   *
   * `exceptAccountId` is what lets a stale row re-authenticate: a row signing
   * back into its *own* account necessarily matches itself, and treating that
   * as a duplicate would make the refusal a permanent lockout for exactly the
   * rows that most need to reconnect.
   */
  findByExternalId(
    serviceId: string,
    externalId: string,
    exceptAccountId?: string,
  ): CredentialRoute | undefined {
    return this.list(serviceId).find(
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
    serviceId: string,
    accountId: string,
    identity: { externalId: string; email?: string },
  ): CredentialRoute {
    const account = this.require(serviceId, accountId);
    const adoptLabel = account.labelIsGenerated === true && identity.email !== undefined;
    this.credentialStore.upsertCredentialRoute({
      ...account,
      externalId: identity.externalId,
      ...(adoptLabel ? { label: identity.email! } : {}),
    });
    return this.require(serviceId, accountId);
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
    serviceId: string,
    accountId: string,
    matched: CredentialRoute,
  ): "deleted" | "reset" {
    const provider = requireHarness(serviceId);
    const account = this.require(serviceId, accountId);
    console.warn(
      `[provider-accounts] refusing ${provider} sign-in on ${accountId}: `
      + `already connected as "${matched.label}" (${matched.id})`,
    );
    if (account.externalId === undefined) {
      this.delete(serviceId, accountId);
      return "deleted";
    }
    fs.rmSync(this.resolveCredentialRoot(provider, accountId), { recursive: true, force: true });
    fs.mkdirSync(this.resolveCredentialRoot(provider, accountId), { recursive: true });
    this.setAccountStatus(serviceId, accountId, "auth_failed");
    return "reset";
  }

  /**
   * docs/150-multiple-provider-subscriptions req 21 — stamp an account as used, now.
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
  markAccountUsed(serviceId: string, accountId: string): void {
    const account = this.get(serviceId, accountId);
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
    const peak = this.list(serviceId).reduce((max, a) => Math.max(max, a.lastUsedAt ?? 0), 0);
    this.credentialStore.upsertCredentialRoute({
      ...account,
      lastUsedAt: Math.max(Date.now(), peak + 1),
    });
  }


  delete(serviceId: string, accountId: string): void {
    const provider = requireHarness(serviceId);
    this.require(serviceId, accountId);
    // Deleting the row that owns the in-flight login must also end that login.
    // Otherwise the CLI keeps running against a credential root we are about to
    // remove, and the manager keeps reporting the deleted account as the active
    // scope — which `startAccountAuth` reads, so every later sign-in for this
    // provider is refused by a row that no longer exists and therefore has no
    // Cancel button. The provider would be locked out of sign-in until the
    // process exited or the orchestrator restarted.
    const loginId = loginIntegrationForService(serviceId);
    const mgr = loginId ? this.authManagers?.get(loginId) : undefined;
    if (mgr?.getActiveAccountId() === accountId) mgr.cancel();
    // `provider` (the harness), not `loginId`: the credential root is the CLI's
    // own home directory. See `harnessesForLoginIntegration` in the catalogue.
    fs.rmSync(this.resolveCredentialRoot(provider, accountId), { recursive: true, force: true });
    this.credentialStore.deleteCredentialRoute(accountId);
  }

  require(serviceId: string, accountId: string): CredentialRoute {
    const account = this.get(serviceId, accountId);
    if (!account) throw new Error(`Provider account not found: ${serviceId}/${accountId}`);
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
   * contradicts docs/150-multiple-provider-subscriptions req 3 (continue on another connected account) and
   * req 12 (never route onto pay-as-you-go billing because a subscription is
   * unavailable).
   *
   * Ordering here is "primary, then stored order" — the user-controlled
   * priority list (req 2) and quota-aware ranking (reqs 6/7) land with the
   * later phases; this is the eligibility walk they will extend, not the final
   * policy.
   */
  selectRouteForTurn(serviceId: string): ProviderRoute | null {
    const selection = this.selectAccountForTurn(serviceId);
    return selection.ok ? selection.route : null;
  }

  /**
   * The env-delivered fallback for a service, if the deployment configured one.
   *
   * Deliberately **not** narrowed to this manager's own subscription mode: for
   * Anthropic it will name the metered `claude-api-key` when no OAuth token is
   * set. That is the pre-feature behaviour and the only path that still reaches
   * it is the one where the session names no `(service, mode)` selection at all
   * (`service-routing.ts` → `selectRouteForSelection`), where there is no mode
   * to be narrowed to. A session that DOES name a mode never sees this: that
   * caller takes an account answer or resolves the string-delivered credential
   * of its own mode, which is what closed req 12's `sub` → metered leak.
   */
  private reservedRouteFor(serviceId: string): ProviderRoute | null {
    for (const candidate of RESERVED_ENV_ROUTES[serviceId] ?? []) {
      if (process.env[candidate.env]?.trim()) return { kind: "reserved", id: candidate.id };
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
  selectAccountForTurn(serviceId: string, opts: SelectAccountOptions = {}): AccountSelection {
    const exclude = new Set(opts.exclude ?? []);
    const mode = this.credentialStore.getSelectionMode(...routingSettingsKeyFor(serviceId));
    const eligible = this.accountsInSelectionOrder(serviceId).filter(
      (account) => account.status === "ready" || account.status === "authenticating",
    );
    const connected = orderForSelectionMode(
      eligible.filter((account) => !exclude.has(account.id)),
      mode,
    );

    // docs/252 req 10 — quota is keyed by `(service, billing mode)` now.
    // Accounts are always subscriptions, so this manager's group is exactly
    // `routingSettingsKeyFor`'s, which is where its cutoffs already come from.
    const limits = this.subscriptionLimitsFor(...routingSettingsKeyFor(serviceId));
    const now = Date.now();
    const cutoffs = this.credentialStore.getFailoverCutoffs(...routingSettingsKeyFor(serviceId));

    // docs/260-turn-level-account-routing reqs 5, 9 — four tiers, and only the last one skips. Telemetry
    // (a snapshot claiming 100%) ORDERS an account to the back but cannot
    // block it: an account whose data says it is spent is still tried, last —
    // that is req 9's "try once to confirm". The only skip is refusal memory:
    // a refusal the harness itself reported, remembered until the stated
    // reset and re-probed within REFUSAL_REPROBE_MS.
    const clear: CredentialRoute[] = [];
    const overCutoff: CredentialRoute[] = [];
    const looksSpent: CredentialRoute[] = [];
    const blocked: CredentialRoute[] = [];
    const blockedResets: number[] = [];
    for (let account of connected) {
      // req 9's early clear, applied lazily at the read: the live snapshot map
      // already carries whatever the refresh button or a probe turn fetched,
      // so a blocked account with a newer healthy reading unblocks right here
      // — no separate reconciliation pass, no event ordering to get wrong.
      if (
        refusalBlockedUntil(account, now) !== null
        && this.clearRefusalOnHealthyReading(serviceId, account.id, limits[account.id])
      ) {
        account = this.get(serviceId, account.id) ?? account;
      }
      const blockedUntil = refusalBlockedUntil(account, now);
      if (blockedUntil !== null) {
        blocked.push(account);
        blockedResets.push(blockedUntil);
        continue;
      }
      if (snapshotExhaustedResetAt(limits[account.id], now) !== null) {
        looksSpent.push(account);
        continue;
      }
      if (isOverCutoff(limits[account.id], cutoffs, now)) {
        overCutoff.push(account);
        continue;
      }
      clear.push(account);
    }

    // docs/260-turn-level-account-routing req 8 — `balanced` spreads SESSIONS, not turns: the account
    // backing a live resident process keeps serving its session while it is
    // clear. Only the clear tier qualifies — a resident account that is over
    // its cutoff or looks spent has stopped being "equally ranked" and the
    // normal walk decides. Under `strict` the strategy is absolute, so the
    // option is not consulted at all.
    if (mode === "balanced" && opts.residentRouteId) {
      const resident = clear.find((account) => account.id === opts.residentRouteId);
      if (resident) return { ok: true, route: { kind: "account", id: resident.id } };
    }

    const pick = clear[0] ?? overCutoff[0] ?? looksSpent[0];
    if (pick) return { ok: true, route: { kind: "account", id: pick.id } };

    // Everything left is refusal-blocked (or was excluded after refusing this
    // very turn). req 7 — a spent subscription must never silently roll onto
    // pay-as-you-go billing, so the reserved env/API-key fallback is dead
    // whenever any subscription account exists; it serves only installs with
    // no accounts at all.
    if (blocked.length > 0 || eligible.length > connected.length) {
      // req 12 — a caller that will actually ATTEMPT the result may take the
      // best blocked account anyway; only refusals from real attempts this
      // turn may produce the terminal failure.
      const probe = blocked[0];
      if (opts.optimistic && probe) return { ok: true, route: { kind: "account", id: probe.id } };
      const earliest = Math.min(...blockedResets);
      return {
        ok: false,
        reason: "all_exhausted",
        earliestResetAt: Number.isFinite(earliest) ? new Date(earliest).toISOString() : null,
      };
    }
    // No connected subscription at all — fall back to reserved routes so
    // env/API-key users keep working.
    const reserved = this.reservedRouteFor(serviceId);
    if (reserved && !exclude.has(reserved.id)) return { ok: true, route: reserved };
    return { ok: false, reason: "auth_required" };
  }

  /**
   * Does this **harness** have any credential of its own vendor's?
   *
   * The one predicate that stays keyed by harness, because it is asked by
   * harness-shaped callers ("can I drive this CLI at all?") and answered from
   * the harness's own vendor. Everything about *choosing* between credentials
   * is keyed by service; this only asks whether the vendor's set is empty.
   */
  hasAnyAuthForProvider(provider: AgentId): boolean {
    const serviceId = nativeServiceForHarness(provider);
    if (serviceId && this.list(serviceId).some((account) => account.status === "ready")) return true;
    return (RESERVED_ENV_ROUTES[serviceId ?? ""] ?? []).some(
      (candidate) => Boolean(process.env[candidate.env]?.trim()),
    );
  }

  /**
   * The account row behind a bare route id, whatever service it belongs to.
   * For callers that hold only the id (notice labels, attempt ledgers) —
   * everything that knows its service keeps asking `get(serviceId, id)`.
   */
  getByRouteId(routeId: string): CredentialRoute | undefined {
    for (const serviceId of accountServiceIds()) {
      const account = this.get(serviceId, routeId);
      if (account) return account;
    }
    return undefined;
  }

  resolveCredentialRoot(provider: AgentId, accountId: string): string {
    return path.join(this.credentialsDir, PROVIDER_ACCOUNTS_SUBDIR, provider, accountId);
  }

  /**
   * docs/150-multiple-provider-subscriptions req 7 — stamp an account as out of quota until `until` (epoch ms).
   *
   * This is the *hard* exhaustion signal: the provider failed a turn saying the
   * subscription is spent. It has to be persisted rather than inferred from the
   * live quota snapshot, because that snapshot is telemetry — it can lag the
   * failure, can report `usedPct: null` below a warning threshold, and for a
   * freshly connected account may not exist at all. Without the stamp the
   * router would keep choosing the account that just refused the turn.
   *
   * The NEWEST refusal's stated reset wins outright (docs/260-turn-level-account-routing req 9): a
   * re-probe answered with "resets in five minutes" must supersede an older
   * week-long estimate, and `refusalBlockedUntil`'s 30-minute cap bounds the
   * cost of the reverse direction (a vaguer short fallback replacing a longer
   * stated reset re-probes once more, nothing worse). Reserved routes are not
   * accounts and are silently ignored (req 12 — metered billing has no
   * subscription window).
   */
  markAccountExhausted(serviceId: string, accountId: string, until: number): CredentialRoute | null {
    const account = this.get(serviceId, accountId);
    if (!account) return null;
    this.credentialStore.upsertCredentialRoute({
      ...account,
      exhaustedUntil: until,
      // Refresh this clock on every hard failure — `refusalBlockedUntil`
      // reads `min(until, at + cap)`, so the clock is what re-arms the
      // 30-minute re-probe window.
      exhaustedAt: Date.now(),
    });
    return this.get(serviceId, accountId) ?? null;
  }

  /**
   * Clear a hard-exhaustion stamp after the credential behind an account row
   * has been replaced by a successful scoped sign-in. The stamp belongs to
   * the old credential, not to the stable row that holds labels and routing
   * preferences.
   */
  clearAccountExhaustion(serviceId: string, accountId: string): CredentialRoute {
    const account = this.require(serviceId, accountId);
    if (account.exhaustedUntil === null || account.exhaustedUntil === undefined) return account;
    this.credentialStore.upsertCredentialRoute({ ...account, exhaustedUntil: null, exhaustedAt: null });
    return this.require(serviceId, accountId);
  }

  /**
   * docs/260-turn-level-account-routing req 9 — a quota reading that is newer than a refusal and shows
   * the account healthy clears the refusal memory immediately, so "user
   * upgrades their plan and presses the refresh button" re-opens the account
   * on the very next turn instead of waiting out the re-probe cap.
   *
   * The trust bar is deliberately low — `usedPct: null` counts as healthy
   * (the provider only reports a number above a warning threshold), and no
   * completeness proof is demanded — because a wrong clear now costs one
   * refused attempt (req 5), not a wrongly-run turn. Called from the two
   * places readings arrive: the rate-limit event push and the usage-API
   * refresh (`bootstrap-managers.ts`).
   */
  clearRefusalOnHealthyReading(
    serviceId: string,
    accountId: string,
    snapshot: { session?: unknown; weekly?: unknown; fetchedAt?: unknown } | undefined,
  ): boolean {
    const account = this.get(serviceId, accountId);
    if (!account) return false;
    if (account.exhaustedUntil === null || account.exhaustedUntil === undefined) return false;
    if (!snapshot || typeof snapshot.fetchedAt !== "number" || !Number.isFinite(snapshot.fetchedAt)) return false;
    const observedAt = typeof account.exhaustedAt === "number" ? account.exhaustedAt : 0;
    if (snapshot.fetchedAt <= observedAt) return false;
    const now = Date.now();
    for (const key of ["session", "weekly"] as const) {
      const window = snapshot[key] as { usedPct?: unknown; resetAt?: unknown } | null | undefined;
      // A newer snapshot can still carry one window the provider did not
      // re-report; if that window has since rolled over, its 100% must not
      // hold the refusal open against the reading the user just asked for.
      if (!subscriptionWindowIsCurrent(window, now)) continue;
      if (typeof window?.usedPct === "number" && window.usedPct >= 100) return false;
    }
    this.credentialStore.upsertCredentialRoute({ ...account, exhaustedUntil: null, exhaustedAt: null });
    return true;
  }

  /** Overwrite the persisted status of an account (idempotent). */
  setAccountStatus(serviceId: string, accountId: string, status: CredentialStatus): CredentialRoute {
    const account = this.require(serviceId, accountId);
    if (account.status === status) return account;
    this.credentialStore.upsertCredentialRoute({ ...account, status });
    return this.require(serviceId, accountId);
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
  startAccountAuth(serviceId: string, accountId: string): CredentialRoute {
    const provider = requireHarness(serviceId);
    this.require(serviceId, accountId);
    const mgr = this.requireAuthManager(serviceId);
    // There is ONE login process per provider, so two rows cannot sign in at
    // once. Without this guard the second `Add account` marked its own row
    // `authenticating` and then either inherited the first row's challenge
    // (Codex replays the cached device code) or killed the first row's flow
    // while leaving that row stuck on `authenticating` (Claude). Either way one
    // row showed a state that did not match any real process. Refusing is the
    // honest outcome: the user finishes or cancels the other sign-in first.
    const inFlight = mgr.getActiveAccountId();
    if (inFlight && inFlight !== accountId) {
      const label = this.get(serviceId, inFlight)?.label ?? inFlight;
      throw new Error(
        `${PROVIDER_LABEL[provider]} is already signing in on "${label}". Finish or cancel that sign-in first.`,
      );
    }
    const credentialDir = this.resolveCredentialRoot(provider, accountId);
    fs.mkdirSync(credentialDir, { recursive: true });
    const account = this.setAccountStatus(serviceId, accountId, "authenticating");
    try {
      mgr.start({ accountId, credentialDir });
    } catch (err) {
      // A failed spawn must not leave the row claiming to be signing in: with
      // the guard above, a phantom `authenticating` row blocks every other
      // account's sign-in, and the caller only sees an error string. Put the
      // row back and release any scope the manager took before throwing.
      this.setAccountStatus(serviceId, accountId, "unavailable");
      try { mgr.cancel(); } catch { /* best effort — the flow may never have started */ }
      throw err;
    }
    return account;
  }

  /**
   * Cancel an in-flight scoped login. Resets the row's status to `ready` when
   * the account already has on-disk credentials, otherwise `unavailable`.
   */
  cancelAccountAuth(serviceId: string, accountId: string): CredentialRoute {
    const provider = requireHarness(serviceId);
    this.require(serviceId, accountId);
    const mgr = this.requireAuthManager(serviceId);
    // Only kill the CLI if it is *this* account's flow. An unconditional
    // cancel let one row's Cancel button abort another row's sign-in — and
    // since the status reset below only touches the row that was clicked, the
    // aborted row would have sat on `authenticating` forever. Resetting this
    // row's status still happens either way: the row is not signing in now,
    // whatever the process is doing.
    const inFlight = mgr.getActiveAccountId();
    if (!inFlight || inFlight === accountId) mgr.cancel();
    const credentialDir = this.resolveCredentialRoot(provider, accountId);
    const status: CredentialStatus = mgr.isConfigured({ credentialDir }) ? "ready" : "unavailable";
    return this.setAccountStatus(serviceId, accountId, status);
  }

  /**
   * Submit a verification code into an in-flight scoped Claude login. No-op
   * for providers whose flow has no paste-code step (Codex device-auth).
   */
  submitAccountCode(serviceId: string, accountId: string, code: string): void {
    const provider = requireHarness(serviceId);
    this.require(serviceId, accountId);
    const mgr = this.requireAuthManager(serviceId);
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
      const label = inFlight ? this.get(serviceId, inFlight)?.label ?? inFlight : null;
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
  signOutAccount(serviceId: string, accountId: string): CredentialRoute {
    const provider = requireHarness(serviceId);
    this.require(serviceId, accountId);
    const mgr = this.requireAuthManager(serviceId);
    const credentialDir = this.resolveCredentialRoot(provider, accountId);
    mgr.signOut({ credentialDir });
    return this.setAccountStatus(serviceId, accountId, "unavailable");
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
   * per-session copies, and then calls this (planning#285).
   */
  signOutProvider(provider: AgentId): void {
    const serviceId = nativeServiceForHarness(provider);
    for (const account of serviceId ? this.list(serviceId) : []) {
      this.delete(serviceId!, account.id);
    }
    if (serviceId) this.requireAuthManager(serviceId).signOut();
  }

  /**
   * The login flow that authenticates `serviceId`.
   *
   * Keyed by `LoginIntegrationId`, which the catalogue declares on the mode's
   * account credential — NOT by `requireHarness(serviceId)`. The harness answers
   * a different question ("whose home directory do these credentials live in"),
   * and it only doubles as the login key while every harness has exactly one
   * native service. Callers that need the harness still ask for it separately;
   * `resolveCredentialRoot` is the one that must.
   */
  private requireAuthManager(serviceId: string): AgentAuthManager {
    const loginId = loginIntegrationForService(serviceId);
    const mgr = loginId ? this.authManagers?.get(loginId) : undefined;
    if (!mgr) throw new Error(`No auth manager wired for service: ${serviceId}`);
    return mgr;
  }

  private migrateProviderDefault(provider: AgentId, accountId: string, label: string): void {
    const serviceId = nativeServiceForHarness(provider);
    if (!serviceId) return;
    if (this.list(serviceId).length > 0) return;

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
    this.credentialStore.upsertCredentialRoute({
      id: accountId,
      serviceId,
      billingMode: ACCOUNT_BILLING_MODE,
      via: "account",
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

/**
 * The placeholder label for a newly created account: the provider's own name
 * ("Claude", "Codex") for the first one, then "Claude2", "Claude3", … The
 * common case is a single account per provider, and there "Claude account 1"
 * read as machine-generated bookkeeping for a number the user never chose.
 *
 * Suffixes skip labels already in use — including user-typed ones — so a row
 * renamed to "Claude" doesn't collide with the next generated placeholder.
 */
function generatedAccountLabel(provider: AgentId, existing: readonly CredentialRoute[]): string {
  const base = PROVIDER_LABEL[provider];
  const taken = new Set(existing.map((account) => account.label));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
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
 * docs/150-multiple-provider-subscriptions req 21 — reorder the eligible accounts according to the provider's
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
export function orderForSelectionMode<T extends { lastUsedAt?: number }>(
  accounts: readonly T[],
  mode: AccountSelectionMode,
): T[] {
  if (mode !== "balanced") return [...accounts];
  return [...accounts].sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
}

/**
 * docs/260-turn-level-account-routing req 5 — what the TELEMETRY claims about a window, used only to
 * order an account to the back of the walk ("looks spent, try last"), never
 * to skip it. The refusal memory in `refusalBlockedUntil` (shared,
 * `credential-route.ts`) is the only thing that skips.
 */
export function snapshotExhaustedResetAt(
  limits: { session?: unknown; weekly?: unknown } | undefined,
  now: number,
): number | null {
  const resets: number[] = [];
  for (const key of ["session", "weekly"] as const) {
    const window = limits?.[key] as { usedPct: number | null; resetAt: string } | null | undefined;
    if (window === null || window === undefined) continue;
    if (window.usedPct === null || window.usedPct < 100) continue;
    // A spent window that no longer describes now is stale, not spent — and an
    // unusable `resetAt` is the worse half of that: it never expires, so it
    // parked the account in the last tier for the life of the snapshot with no
    // clock to end it. Both are "not evidence"; the harness's own refusal is
    // what may bench an account (req 5).
    if (!subscriptionWindowIsCurrent(window, now)) continue;
    resets.push(Date.parse(window.resetAt));
  }
  if (resets.length === 0) return null;
  return Math.min(...resets);
}

function readClaudeAccessToken(file: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return probeNestedString(
      parsed as Record<string, unknown>,
      ["accessToken", "access_token"],
      "claudeAiOauth",
    );
  } catch {
    return null;
  }
}


/**
 * docs/150-multiple-provider-subscriptions reqs 4–6 — has this account crossed either proactive cutoff?
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
 *
 * A window that no longer describes now (`subscriptionWindowIsCurrent`) is not
 * over its cutoff either (docs/260-turn-level-account-routing req 8). Without that rule an account that
 * hit its 5h limit stayed demoted after the limit reset — permanently, under
 * strict priority, because the demotion is exactly what kept turns off the
 * account whose turns are the only source of a fresher reading, and a demoted
 * account is never reached at all while any account is clear.
 */
export function isOverCutoff(
  limits: { session?: unknown; weekly?: unknown } | undefined,
  cutoffs: FailoverCutoffs,
  now: number,
): boolean {
  for (const [key, cutoff] of [["session", cutoffs.session], ["weekly", cutoffs.weekly]] as const) {
    const window = limits?.[key] as { usedPct: number | null; resetAt?: unknown } | null | undefined;
    if (window?.usedPct === null || window?.usedPct === undefined) continue;
    if (!subscriptionWindowIsCurrent(window, now)) continue;
    if (window.usedPct >= cutoff) return true;
  }
  return false;
}

/**
 * The pre-`priority` ordering rule — primary first, then stored order — kept
 * ONLY to seed {@link ProviderAccountManager.backfillPriority}, so the
 * one-time backfill records the order an existing install already had instead
 * of reshuffling it. Nothing on the read path uses this.
 *
 * The read path's own rule (`priority` ascending, a missing one sorting last,
 * `isPrimary` stamped from position) is `orderCredentialRoutes` and lives with
 * the type — one implementation, shared with the string-delivered credentials
 * that never had a second one.
 */
function legacyRank(
  entry: { route: CredentialRoute; index: number },
  primaryId: string | undefined,
): number {
  if (typeof entry.route.priority === "number") return entry.route.priority;
  if (entry.route.id === primaryId) return Number.NEGATIVE_INFINITY;
  return entry.index;
}
