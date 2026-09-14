import type { AgentId, CredentialRoute, RepoInfo, WsServerMessage } from "../../shared/types.js";
import type { McpServerConfig } from "../../shared/types/mcp-types.js";
import {
  APPLIED,
  applyFailed,
  applyUncertain,
  combineOutcomes,
  payloadDeclarations,
} from "../../shared/settings-catalogue/index.js";
import type { ApplyOutcome } from "../../shared/settings-catalogue/index.js";
import type { AgentMergeClaimStore } from "../agent-merge-claims.js";
import type { ChatHistoryManager } from "../chat-history.js";
import { buildSystemNotice } from "../chat-card-persistence.js";
import type { CredentialStore } from "../credential-store.js";
import { EGRESS_GLOBAL_SCOPE } from "../egress-allowlist-store.js";
import type { EgressAllowlistStore } from "../egress-allowlist-store.js";
import {
  buildEffectiveAllowlist,
  hostMatchesEntry,
  isBuiltinDefault,
  normalizeHost,
} from "../egress-allowlist.js";
import { repoId } from "../git-utils.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { RepoStore } from "../repo-store.js";
import type { ServiceManager } from "../service-manager.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import { refreshAgentEnvForAllSessions } from "../session-agent-env.js";
import { getErrorMessage } from "../validation.js";
import {
  addMcpServer,
  removeMcpServer,
  setMcpServerEnabled,
  updateMcpServer,
} from "./mcp.js";
import {
  listRepos,
  setRepoColorIndex,
  setRepoHidden,
} from "./repos.js";
import {
  renameProviderAccount,
  reorderProviderAccounts,
  saveGlobalSettings,
  setGitIdentityService,
} from "./settings.js";
import type { SaveGlobalSettingsOptions } from "./settings.js";
import { reorderCredentialRoutes, updateStringCredential } from "./credential-routes.js";
import {
  credentialRouteDomain,
  credentialRoutesDomain,
  egressScopeDomain,
  gitIdentityDomain,
  mcpServerDomain,
  providerAccountsDomain,
  releaseChannelDomain,
  repositoryDomain,
  reviewerSlotsDomain,
  roleDomain,
  settingsPayloadDomain,
  withConflictDomains,
} from "./settings-conflict-domain.js";
import type { ConflictDomain } from "./settings-conflict-domain.js";
import { checkForUpdates, writeReleaseChannel } from "./updates.js";
import type { GlobalSettings } from "./types.js";
import { ServiceError } from "./types.js";

/**
 * The one door every ShipIt settings write goes through
 * (docs/299-agent-settings-access, plan.md → Apply goes through a shared layer).
 *
 * **Calling the service under a route does not inherit the route's behaviour**,
 * and that is the whole reason this exists. `EgressAllowlistStore.addHost`
 * writes one row, while unsuppressing a built-in default, the broadcast and —
 * for a *session* host only — the live reload all lived in the route, so a
 * second caller of the store got a row and none of the rest.
 * `saveGlobalSettings` broadcast nothing at all; the dialog only got away with
 * that because each toggle writes its own browser store before the PUT. Revoking
 * agent-merge cancels pending merge requests in the route, not in the store.
 *
 * So an operation here is **the whole act**: the durable write, everything the
 * shipped route did to make that write take effect, the conflict-domain lock,
 * and one settings broadcast. A caller that reached for the underlying service
 * and remembered to do the rest by hand is exactly the omission this removes —
 * the centralisation has to be of the act, not of a helper each caller must
 * remember to call. Where an operation needs something only its caller can
 * build — the credential propagation, a broadcast carrying status this layer
 * does not resolve — it is a **required** field of that operation's deps, so a
 * second caller cannot omit it. Optional would mean forgettable.
 *
 * What stays with the caller is what is not part of the write taking effect:
 * the quota refresh a replaced secret schedules, and the response body each
 * route shapes.
 *
 * Every operation reports an {@link ApplyOutcome} rather than returning `void`,
 * because "applied" must not be able to be false (plan.md → "Saved" has to mean
 * saved). Validation still throws {@link ServiceError}: a refused write changed
 * nothing and is not an outcome, it is a 400.
 */

/** The SSE event a settings write raises. Viewers refetch; nothing is pushed inline. */
export const SETTINGS_CHANGED_EVENT = "settings_changed";

export interface SettingsBroadcastDeps {
  sseBroadcast: (event: string, data: unknown) => void;
}

/**
 * Tell every viewer a setting moved.
 *
 * New work, not inherited: a broadcast does not reach a viewer that was away,
 * and the client's recovery refetch is the other half — the dialog can be open
 * on the home screen, where the session-scoped hydration path never runs.
 */
function broadcastSettingsChanged(deps: SettingsBroadcastDeps, keys: readonly string[]): void {
  deps.sseBroadcast(SETTINGS_CHANGED_EVENT, { keys: [...keys] });
}

/**
 * A refused write is not a failed one. `ServiceError` is validation — an unknown
 * repository, a malformed host — and it changed nothing on purpose, so it stays
 * the 4xx the caller already answers with rather than becoming an outcome that
 * would report the same refusal as a 500.
 */
function outcomeOf(err: unknown): ApplyOutcome {
  if (err instanceof ServiceError) throw err;
  return applyFailed(getErrorMessage(err));
}

// ---------------------------------------------------------------------------
// PUT /api/settings — the declared global scalars, plus the panels it carries
// ---------------------------------------------------------------------------

export interface GlobalSettingsWriteResult {
  settings: GlobalSettings;
  outcome: ApplyOutcome;
}

/**
 * The domains one settings save writes. The payload's own scalars share a
 * domain; a role, the reviewer slots and the git identity are stored objects of
 * their own, so a save touching them takes theirs too — which is what makes a
 * dialog save and a single-field write to the same role serialize.
 *
 * Exported because a proposal apply holds the lock across its baseline check and
 * this write, and must name the same set from the same options rather than a
 * second list that could drift from it.
 */
export function domainsForSettingsSave(opts: SaveGlobalSettingsOptions): ConflictDomain[] {
  const domains: ConflictDomain[] = [settingsPayloadDomain];
  if (opts.gitIdentity !== undefined) domains.push(gitIdentityDomain);
  if (opts.reviewers !== undefined) domains.push(reviewerSlotsDomain);
  for (const [name, patch] of Object.entries(opts.roles ?? {})) {
    domains.push(roleDomain(name));
    // A rename writes both names, so both have to be held.
    const previous = patch && typeof patch === "object" ? (patch as { previousName?: unknown }).previousName : undefined;
    if (typeof previous === "string" && previous) domains.push(roleDomain(previous));
  }
  return domains;
}

/**
 * What the save changed, for the broadcast. Only the settings themselves: the
 * option bag also carries the managers and the callbacks this function needs,
 * and naming those as settings that moved would be nonsense a viewer acts on.
 */
function changedKeysOfSettingsSave(opts: SaveGlobalSettingsOptions): string[] {
  const named = Object.keys(opts as unknown as Record<string, unknown>);
  const wires = new Set(payloadDeclarations().map((declaration) => declaration.wire));
  const panels = ["failoverCutoffs", "accountSelectionMode", "reviewers", "roles"];
  return named.filter((key) => wires.has(key) || panels.includes(key));
}

export async function applyGlobalSettings(
  deps: SettingsBroadcastDeps,
  opts: SaveGlobalSettingsOptions,
): Promise<GlobalSettingsWriteResult> {
  return withConflictDomains(domainsForSettingsSave(opts), async () => {
    const { settings, outcome } = await saveGlobalSettings(opts);
    broadcastSettingsChanged(deps, changedKeysOfSettingsSave(opts));
    return { settings, outcome };
  });
}

export interface GitIdentityWriteResult {
  identity: { name: string; email: string };
  outcome: ApplyOutcome;
}

export async function applyGitIdentity(
  deps: SettingsBroadcastDeps,
  name: string,
  email: string,
): Promise<GitIdentityWriteResult> {
  return withConflictDomains([gitIdentityDomain], () => {
    const result = setGitIdentityService(name, email);
    broadcastSettingsChanged(deps, ["git.identity"]);
    return result;
  });
}

// ---------------------------------------------------------------------------
// Credential routing and provider accounts
// ---------------------------------------------------------------------------

/**
 * What a credential write needs beyond the store.
 *
 * `propagateCredentialChange` and `broadcastCredentialRoutes` are **required**,
 * not optional: they are half of what the shipped route did, and an optional
 * field is a field a second caller forgets. Making them part of the operation's
 * type is what stops the layer from being a helper each caller must remember to
 * pair with two more calls.
 */
export interface CredentialApplyDeps extends SettingsBroadcastDeps {
  credentialStore: CredentialStore;
  /** Refresh every harness's auth, push agent env, release idle resident CLIs. */
  propagateCredentialChange: () => void;
  broadcastCredentialRoutes: (routes: CredentialRoute[]) => void;
}

export interface CredentialRoutesWriteResult {
  routes: CredentialRoute[];
  route?: CredentialRoute;
  outcome: ApplyOutcome;
}

export async function applyCredentialRouteOrder(
  deps: CredentialApplyDeps,
  serviceId: string,
  billingMode: string,
  routeIds: unknown,
): Promise<CredentialRoutesWriteResult> {
  return withConflictDomains([credentialRoutesDomain(serviceId, billingMode)], () => {
    const { value, outcome } = deps.credentialStore.transact(() =>
      reorderCredentialRoutes(deps.credentialStore, serviceId, billingMode, routeIds),
    );
    deps.propagateCredentialChange();
    deps.broadcastCredentialRoutes(value.routes);
    broadcastSettingsChanged(deps, ["services.credentialRouting"]);
    return { ...value, outcome };
  });
}

/**
 * A stored credential's label — and, on the same route, its secret. Both are one
 * stored object, so both take that credential's domain, AND the ordering domain
 * for its service and mode: a reorder rewrites the same row's priority.
 */
export async function applyCredentialUpdate(
  deps: CredentialApplyDeps,
  routeId: string,
  patch: { label?: string; secret?: string },
): Promise<CredentialRoutesWriteResult> {
  const route = deps.credentialStore.getCredentialRoute(routeId);
  const domains = [
    credentialRouteDomain(routeId),
    ...(route ? [credentialRoutesDomain(route.serviceId, route.billingMode)] : []),
  ];
  return withConflictDomains(domains, () => {
    const { value, outcome } = deps.credentialStore.transact(() =>
      updateStringCredential(deps.credentialStore, routeId, patch),
    );
    deps.propagateCredentialChange();
    deps.broadcastCredentialRoutes(value.routes);
    broadcastSettingsChanged(deps, ["services.credentialLabel"]);
    return { ...value, outcome };
  });
}

/**
 * A credential's display name, and nothing else — the narrow writer for a narrow
 * operation, as `setMcpServerEnabled` is for the `enabled` toggle. It omits
 * `propagateCredentialChange` deliberately: that refreshes auth, agent
 * environments and resident CLIs on the strength of credential MATERIAL.
 */
export async function applyCredentialLabel(
  deps: SettingsBroadcastDeps & { credentialStore: CredentialStore },
  routeId: string,
  label: string,
): Promise<CredentialRoutesWriteResult> {
  return withConflictDomains(credentialLabelDomains(deps.credentialStore, routeId), () => {
    const { value, outcome } = deps.credentialStore.transact(() =>
      updateStringCredential(deps.credentialStore, routeId, { label }),
    );
    deps.sseBroadcast("credential_routes", { routes: value.routes });
    broadcastSettingsChanged(deps, ["services.credentialLabel"]);
    return { ...value, outcome };
  });
}

/**
 * The domains a credential-label write takes. Exported because a proposal holds
 * them across its baseline check and this write, and the nested acquisition here
 * has to be a subset of what the caller already holds.
 */
export function credentialLabelDomains(
  credentialStore: Pick<CredentialStore, "getCredentialRoute">,
  routeId: string,
): ConflictDomain[] {
  const route = credentialStore.getCredentialRoute(routeId);
  return [
    credentialRouteDomain(routeId),
    // A reorder rewrites the same row's priority, and this write upserts the
    // whole row. A route's service and billing mode are fixed for its life, so
    // resolving them before the lock cannot read a value the write decides.
    ...(route ? [credentialRoutesDomain(route.serviceId, route.billingMode)] : []),
  ];
}

export interface ProviderAccountApplyDeps extends SettingsBroadcastDeps {
  credentialStore: CredentialStore;
  providerAccountManager: ProviderAccountManager;
  broadcastProviderAccounts: (accounts: CredentialRoute[]) => void;
}

export interface ProviderAccountsWriteResult {
  accounts: CredentialRoute[];
  account?: CredentialRoute;
  outcome: ApplyOutcome;
}

/**
 * A provider account IS a credential route — `via: "account"`, billing mode
 * `sub` — so an account operation takes that service's routing domain as well
 * as the accounts domain. Ordering accounts and ordering credentials rewrite the
 * same rows' priorities, and under two separate locks a later reorder could
 * overtake an earlier one.
 */
export function providerAccountDomains(serviceId: string): ConflictDomain[] {
  return [providerAccountsDomain, credentialRoutesDomain(serviceId, "sub")];
}

export async function applyProviderAccountOrder(
  deps: ProviderAccountApplyDeps,
  provider: AgentId,
  accountIds: unknown,
): Promise<ProviderAccountsWriteResult> {
  return withConflictDomains(providerAccountDomains(provider), () => {
    const { value, outcome } = deps.credentialStore.transact(() =>
      reorderProviderAccounts(deps.providerAccountManager, provider, accountIds),
    );
    deps.broadcastProviderAccounts(value.accounts);
    broadcastSettingsChanged(deps, ["services.providerAccountOrder"]);
    return { ...value, outcome };
  });
}

export async function applyProviderAccountLabel(
  deps: ProviderAccountApplyDeps,
  provider: AgentId,
  accountId: string,
  label: string,
): Promise<ProviderAccountsWriteResult> {
  return withConflictDomains(providerAccountDomains(provider), () => {
    const { value, outcome } = deps.credentialStore.transact(() =>
      renameProviderAccount(deps.providerAccountManager, provider, accountId, label),
    );
    deps.broadcastProviderAccounts(value.accounts);
    broadcastSettingsChanged(deps, ["services.providerAccountLabel"]);
    return { ...value, outcome };
  });
}

// ---------------------------------------------------------------------------
// Egress — the allowlist and the global containment toggle
// ---------------------------------------------------------------------------

export interface EgressApplyDeps extends SettingsBroadcastDeps {
  egressAllowlistStore: EgressAllowlistStore;
  /**
   * Required, though an install may have none: a configured MCP server is one of
   * the sources the allowlist is assembled from, so a removal that cannot see it
   * reports a host gone that the next container still reaches.
   */
  credentialStore: CredentialStore | undefined;
  containerManager?: { reloadEgress(sessionId: string): Promise<boolean> } | undefined;
  /**
   * The shipped `egress_settings` push, where the caller can build one. It
   * carries enforcement status the caller resolves and this layer does not, so a
   * caller without it (the egress prompt card) omits it and viewers learn from
   * the settings broadcast instead — which is why that one is unconditional.
   */
  broadcastEgressSettings?: (() => void) | undefined;
}

export interface EgressHostWriteResult {
  outcome: ApplyOutcome;
  /** A session-scope live reload ran and succeeded. A global add reloads nothing. */
  reloaded: boolean;
  /** The live refresh failed closed — the caller answers 503 and says so. */
  reloadError?: string;
}

/**
 * Add one host. Three things the store's `addHost` is not: a built-in default is
 * *unsuppressed* rather than added as a duplicate row, the settings broadcast
 * runs, and a **session** host gets the live `reloadEgress` — which a global add
 * deliberately does not, because there is no one session to reload.
 */
export async function applyEgressHostAdd(
  deps: EgressApplyDeps,
  scope: string,
  host: string,
): Promise<EgressHostWriteResult> {
  return withConflictDomains([egressScopeDomain(scope)], async () => {
    const isGlobal = scope === EGRESS_GLOBAL_SCOPE;
    let outcome: ApplyOutcome;
    try {
      if (isGlobal && isBuiltinDefault(host)) deps.egressAllowlistStore.unsuppressDefault(host);
      else deps.egressAllowlistStore.addHost(scope, host);
      outcome = APPLIED;
    } catch (err) {
      console.error(`[settings-apply] adding egress host ${host} to ${scope} failed:`, err);
      return { outcome: outcomeOf(err), reloaded: false };
    }
    deps.broadcastEgressSettings?.();
    broadcastSettingsChanged(deps, ["network.egress.hosts"]);
    if (isGlobal) return { outcome, reloaded: false };
    try {
      const reloaded = (await deps.containerManager?.reloadEgress(scope)) === true;
      return { outcome, reloaded };
    } catch (error) {
      console.error(`[egress:${scope}] allowlist saved but live refresh failed closed:`, error);
      // The row is durable; only the running services are not yet on it.
      return {
        outcome: applyUncertain(
          "The allowlist entry was saved, but refreshing the running services failed closed, so they are not on it yet.",
        ),
        reloaded: false,
        reloadError: getErrorMessage(error),
      };
    }
  });
}

/**
 * Whether the host is still on the GLOBAL list after the write, and why.
 *
 * Read off the resulting state rather than off what the store returned: that
 * list is assembled from several sources and a write reaches two of them
 * (plan.md → "Saved" has to mean saved). A session's list has one source, its
 * own rows, so its write already is the resulting state.
 */
function globalRemovalOutcome(deps: EgressApplyDeps, host: string): ApplyOutcome {
  const store = deps.egressAllowlistStore;
  const target = normalizeHost(host);
  const remaining = buildEffectiveAllowlist({
    ...(deps.credentialStore ? { credentialStore: deps.credentialStore } : {}),
    globalHosts: store.listHosts(EGRESS_GLOBAL_SCOPE),
    suppressedDefaults: store.listSuppressedDefaults(),
  });
  const stillListed = remaining.find((entry) => entry.host === target);
  if (stillListed) {
    return applyFailed(
      stillListed.source === "mcp"
        ? `${stillListed.host} is still allowed: a configured MCP server needs it, so removing it here does not take it off.`
        : stillListed.source === "operator"
          ? `${stillListed.host} is still allowed: this deployment's operator supplies it, and no removal here takes it off.`
          : `${stillListed.host} is still on the global allowlist after the removal, so nothing about what sessions can reach changed.`,
    );
  }
  // Entries are patterns, so removing `api.github.com` leaves the shipped
  // `.github.com` matching it. Membership, not reachability: whether a session
  // reaches the host depends on its own containment, which the card's `effect`
  // answers and this must not talk over.
  const covered = remaining.find((entry) => hostMatchesEntry(target, entry.host));
  return covered
    ? {
        status: "applied",
        detail: `The entry is off the list, and ${covered.host} is still on it and matches ${target}.`,
      }
    : APPLIED;
}

export async function applyEgressHostRemove(
  deps: EgressApplyDeps,
  scope: string,
  host: string,
): Promise<ApplyOutcome> {
  return withConflictDomains([egressScopeDomain(scope)], () => {
    const isGlobal = scope === EGRESS_GLOBAL_SCOPE;
    try {
      // Both, never one or the other. A host can be a shipped default AND an
      // explicit row, and the old branch suppressed the default first and
      // returned — leaving the row effective, advertised again as the user's
      // own, and every further removal reporting success while changing nothing.
      deps.egressAllowlistStore.removeHost(scope, host);
      if (isGlobal && isBuiltinDefault(host)) deps.egressAllowlistStore.suppressDefault(host);
    } catch (err) {
      console.error(`[settings-apply] removing egress host ${host} from ${scope} failed:`, err);
      return outcomeOf(err);
    }
    deps.broadcastEgressSettings?.();
    broadcastSettingsChanged(deps, ["network.egress.hosts"]);
    return isGlobal ? globalRemovalOutcome(deps, host) : APPLIED;
  });
}

export async function applyEgressDefaultsRestore(deps: EgressApplyDeps): Promise<ApplyOutcome> {
  return withConflictDomains([egressScopeDomain(EGRESS_GLOBAL_SCOPE)], () => {
    try {
      deps.egressAllowlistStore.restoreDefaults();
    } catch (err) {
      console.error("[settings-apply] restoring the egress defaults failed:", err);
      return outcomeOf(err);
    }
    deps.broadcastEgressSettings?.();
    broadcastSettingsChanged(deps, ["network.egress.hosts"]);
    return APPLIED;
  });
}

export async function applyEgressGlobalEnabled(
  deps: EgressApplyDeps,
  enabled: boolean,
): Promise<ApplyOutcome> {
  return withConflictDomains([egressScopeDomain(EGRESS_GLOBAL_SCOPE)], () => {
    try {
      deps.egressAllowlistStore.setGlobalEnabled(enabled);
    } catch (err) {
      console.error("[settings-apply] setting global egress containment failed:", err);
      return outcomeOf(err);
    }
    deps.broadcastEgressSettings?.();
    broadcastSettingsChanged(deps, ["network.egressContained"]);
    return APPLIED;
  });
}

// ---------------------------------------------------------------------------
// Release channel
// ---------------------------------------------------------------------------

export interface ReleaseChannelWriteResult<T> {
  /** The check that ran under the new channel, or null when it failed. */
  status: T | null;
  outcome: ApplyOutcome;
  /**
   * The update check after the write threw. The channel is durable either way,
   * so this is never the write's failure: a caller that needs an update status
   * re-raises it.
   */
  checkError?: Error;
}

/**
 * The write and the update check are composed here rather than inside one
 * service call, because only that separates them. `checkForUpdates` throws a
 * 503 of its own when fetching fails — long after the channel has landed — and
 * a single call could not tell that from a channel that never moved.
 *
 * A failed check is therefore NOT a failed write (plan.md → "Saved" has to mean
 * saved), and re-raising it here lost that for every caller: the channel was
 * stored and the proposal card reported the change refused. So it is *returned*
 * beside an `applied` outcome, and the route that wants an update status raises
 * it itself.
 */
export async function applyReleaseChannel(
  deps: SettingsBroadcastDeps,
  channel: "stable" | "edge",
): Promise<ReleaseChannelWriteResult<Awaited<ReturnType<typeof checkForUpdates>>>> {
  return withConflictDomains([releaseChannelDomain], async () => {
    // A refused write — an unknown channel, no host repo — changed nothing and
    // stays the caller's 4xx.
    await writeReleaseChannel(channel);
    broadcastSettingsChanged(deps, ["advanced.releaseChannel"]);
    try {
      return { status: await checkForUpdates(), outcome: APPLIED };
    } catch (err) {
      console.error("[settings-apply] the release channel was written; checking for updates failed:", err);
      return {
        status: null,
        outcome: {
          status: "applied",
          detail: "The channel was written. ShipIt could not check for updates afterwards, so it "
            + "cannot yet say which release this install is on.",
        },
        checkError: err instanceof Error ? err : new Error(getErrorMessage(err)),
      };
    }
  });
}

// ---------------------------------------------------------------------------
// Project settings — the repository row
// ---------------------------------------------------------------------------

export interface RepoSettingsApplyDeps extends SettingsBroadcastDeps {
  repoStore: RepoStore;
  chatHistoryManager: ChatHistoryManager;
  runnerRegistry?: SessionRunnerRegistry | undefined;
  agentMergeClaims?: AgentMergeClaimStore | undefined;
}

export interface RepoSettingsPatch {
  hidden?: boolean | undefined;
  colorIndex?: number | undefined;
  allowAgentMerge?: boolean | undefined;
}

export interface RepoSettingsWriteResult {
  repo: RepoInfo | null;
  outcome: ApplyOutcome;
  /** The repository row is not in the store; the caller answers 404. */
  notFound?: boolean;
}

/**
 * Revoking agent merging cancels the merge requests already claimed under it.
 * This lives beside the write rather than in the route because the grant and its
 * consequences are one act: a second caller that only flipped the flag would
 * leave claims pending against a permission that no longer exists.
 */
function cancelAgentMergeRequests(deps: RepoSettingsApplyDeps, id: string): void {
  if (!id || !deps.agentMergeClaims) return;
  // Persist inside the cancellation transaction; broadcast only after commit.
  const pending: { sessionId: string; ws: WsServerMessage }[] = [];
  deps.agentMergeClaims.cancelPendingForRepo(id, (claim) => {
    const { ws, persisted } = buildSystemNotice(
      claim.sessionId,
      `Cancelled the merge request for pull request #${claim.prNumber}: agent merging was turned off `
      + "for this repository. Nothing was merged.",
      "info",
    );
    deps.chatHistoryManager.append(claim.sessionId, persisted);
    pending.push({ sessionId: claim.sessionId, ws });
  });
  for (const { sessionId, ws } of pending) {
    deps.runnerRegistry?.get(sessionId)?.emitMessage(ws);
  }
}

export async function applyRepoSettings(
  deps: RepoSettingsApplyDeps,
  url: string,
  patch: RepoSettingsPatch,
): Promise<RepoSettingsWriteResult> {
  return withConflictDomains([repositoryDomain(url)], () => {
    const outcomes: ApplyOutcome[] = [];
    const keys: string[] = [];
    try {
      if (patch.colorIndex !== undefined) {
        setRepoColorIndex(deps.repoStore, url, patch.colorIndex);
        outcomes.push(APPLIED);
        keys.push("project.repositoryColor");
      }
      if (patch.hidden !== undefined) {
        setRepoHidden(deps.repoStore, url, patch.hidden);
        outcomes.push(APPLIED);
      }
      if (patch.allowAgentMerge !== undefined) {
        const result = deps.repoStore.setAllowAgentMerge(url, patch.allowAgentMerge);
        if (result === "not-found") {
          return { repo: null, outcome: combineOutcomes(outcomes), notFound: true };
        }
        // `no-identity` returns BEFORE writing anything: the permission is keyed
        // by GitHub repository id, and a remote that has none cannot hold one.
        // Falling through would report a grant that was never stored, which is
        // the one thing an outcome may not do.
        if (result === "no-identity") {
          throw new ServiceError(
            400,
            `${url} is not a GitHub repository, so ShipIt cannot grant agent merging on it.`,
          );
        }
        // The permission is durable here, and recorded here — a failure in the
        // cancellation below must not report it as unchanged, because it did
        // change.
        outcomes.push(APPLIED);
        keys.push("project.allowAgentMerge");
        // Revoke before cancellation; the executor rechecks the grant if cancellation fails.
        if (!patch.allowAgentMerge) {
          try {
            cancelAgentMergeRequests(deps, repoId(url) ?? "");
          } catch (err) {
            console.error(`[settings-apply] cancelling merge requests for ${url} failed:`, err);
            // The executor rechecks the grant, so a claim left pending will not
            // merge — but this cannot promise the cancellation notices landed.
            outcomes.push(applyUncertain(
              "Agent merging is off for this repository, but ShipIt could not cancel the merge requests "
              + "already claimed under it. They will not merge, and the sessions holding them were not told.",
            ));
          }
        }
      }
    } catch (err) {
      console.error(`[settings-apply] writing repository settings for ${url} failed:`, err);
      outcomes.push(outcomeOf(err));
    }
    deps.sseBroadcast("repo_list", { repos: listRepos(deps.repoStore) });
    broadcastSettingsChanged(deps, keys);
    return { repo: deps.repoStore.get(url) ?? null, outcome: combineOutcomes(outcomes) };
  });
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

export interface McpApplyDeps extends SettingsBroadcastDeps {
  credentialStore: CredentialStore;
  serviceManagers: Map<string, ServiceManager>;
}

export interface McpWriteResult<T> {
  value: T;
  outcome: ApplyOutcome;
}

/**
 * Every session's agent environment is rebuilt after an MCP change. It returns
 * `void` and only logs per-session failures, so an apply cannot know that every
 * session refreshed — which is why the outcome covers the stored write and the
 * caller does not claim more (plan.md → Saved is not effective).
 */
function refreshAfterMcpWrite(deps: McpApplyDeps): void {
  refreshAgentEnvForAllSessions(deps.serviceManagers);
  broadcastSettingsChanged(deps, ["mcp.servers"]);
}

export async function applyMcpServerAdd(
  deps: McpApplyDeps,
  config: unknown,
  secrets: unknown,
): Promise<McpWriteResult<McpServerConfig>> {
  const name = typeof (config as { name?: unknown })?.name === "string"
    ? (config as { name: string }).name
    : "";
  return withConflictDomains([mcpServerDomain(name)], () => {
    const { value, outcome } = deps.credentialStore.transact(() =>
      addMcpServer(deps.credentialStore, config, secrets),
    );
    refreshAfterMcpWrite(deps);
    return { value, outcome };
  });
}

export async function applyMcpServerUpdate(
  deps: McpApplyDeps,
  id: string,
  config: unknown,
  secrets: unknown,
): Promise<McpWriteResult<{ config: McpServerConfig; clearedSecretKeys: string[] }>> {
  const renamedTo = typeof (config as { name?: unknown })?.name === "string"
    ? (config as { name: string }).name
    : id;
  // A rename writes both entries, so both domains are held.
  return withConflictDomains([mcpServerDomain(id), mcpServerDomain(renamedTo)], () => {
    const { value, outcome } = deps.credentialStore.transact(() =>
      updateMcpServer(deps.credentialStore, id, config, secrets),
    );
    refreshAfterMcpWrite(deps);
    return { value, outcome };
  });
}

/** A server's `enabled` flag on its own; see {@link setMcpServerEnabled}. */
export async function applyMcpServerEnabled(
  deps: McpApplyDeps,
  id: string,
  enabled: boolean,
): Promise<McpWriteResult<McpServerConfig>> {
  return withConflictDomains([mcpServerDomain(id)], () => {
    const { value, outcome } = deps.credentialStore.transact(() =>
      setMcpServerEnabled(deps.credentialStore, id, enabled),
    );
    refreshAfterMcpWrite(deps);
    return { value, outcome };
  });
}

export async function applyMcpServerRemove(
  deps: McpApplyDeps,
  id: string,
): Promise<McpWriteResult<{ clearedSecretKeys: string[] }>> {
  return withConflictDomains([mcpServerDomain(id)], () => {
    const { value, outcome } = deps.credentialStore.transact(() =>
      removeMcpServer(deps.credentialStore, id),
    );
    refreshAfterMcpWrite(deps);
    return { value, outcome };
  });
}
