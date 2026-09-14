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
import { isBuiltinDefault } from "../egress-allowlist.js";
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
import { readChannel } from "../release-channel.js";
import { setChannel } from "./updates.js";
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
 * shipped route did around it, the conflict-domain lock, and one settings
 * broadcast. A caller that reached for the underlying service and remembered to
 * do the rest by hand is exactly the omission this removes — the centralisation
 * has to be of the act, not of a helper each caller must remember to call.
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
 */
function domainsForSettingsSave(opts: SaveGlobalSettingsOptions): ConflictDomain[] {
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

export interface CredentialRoutesWriteResult {
  routes: CredentialRoute[];
  route?: CredentialRoute;
  outcome: ApplyOutcome;
}

export async function applyCredentialRouteOrder(
  deps: SettingsBroadcastDeps & { credentialStore: CredentialStore },
  serviceId: string,
  billingMode: string,
  routeIds: unknown,
): Promise<CredentialRoutesWriteResult> {
  return withConflictDomains([credentialRoutesDomain(serviceId, billingMode)], () => {
    const { value, outcome } = deps.credentialStore.transact(() =>
      reorderCredentialRoutes(deps.credentialStore, serviceId, billingMode, routeIds),
    );
    broadcastSettingsChanged(deps, ["services.credentialRouting"]);
    return { ...value, outcome };
  });
}

/**
 * A stored credential's label — and, on the same route, its secret. Both are one
 * stored object, so both take that credential's domain.
 */
export async function applyCredentialUpdate(
  deps: SettingsBroadcastDeps & { credentialStore: CredentialStore },
  routeId: string,
  patch: { label?: string; secret?: string },
): Promise<CredentialRoutesWriteResult> {
  return withConflictDomains([credentialRouteDomain(routeId)], () => {
    const { value, outcome } = deps.credentialStore.transact(() =>
      updateStringCredential(deps.credentialStore, routeId, patch),
    );
    broadcastSettingsChanged(deps, ["services.credentialLabel"]);
    return { ...value, outcome };
  });
}

export interface ProviderAccountsWriteResult {
  accounts: CredentialRoute[];
  account?: CredentialRoute;
  outcome: ApplyOutcome;
}

export async function applyProviderAccountOrder(
  deps: SettingsBroadcastDeps & { providerAccountManager: ProviderAccountManager; credentialStore: CredentialStore },
  provider: AgentId,
  accountIds: unknown,
): Promise<ProviderAccountsWriteResult> {
  return withConflictDomains([providerAccountsDomain], () => {
    const { value, outcome } = deps.credentialStore.transact(() =>
      reorderProviderAccounts(deps.providerAccountManager, provider, accountIds),
    );
    broadcastSettingsChanged(deps, ["services.providerAccountOrder"]);
    return { ...value, outcome };
  });
}

export async function applyProviderAccountLabel(
  deps: SettingsBroadcastDeps & { providerAccountManager: ProviderAccountManager; credentialStore: CredentialStore },
  provider: AgentId,
  accountId: string,
  label: string,
): Promise<ProviderAccountsWriteResult> {
  return withConflictDomains([providerAccountsDomain], () => {
    const { value, outcome } = deps.credentialStore.transact(() =>
      renameProviderAccount(deps.providerAccountManager, provider, accountId, label),
    );
    broadcastSettingsChanged(deps, ["services.providerAccountLabel"]);
    return { ...value, outcome };
  });
}

// ---------------------------------------------------------------------------
// Egress — the allowlist and the global containment toggle
// ---------------------------------------------------------------------------

export interface EgressApplyDeps extends SettingsBroadcastDeps {
  egressAllowlistStore: EgressAllowlistStore;
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

export async function applyEgressHostRemove(
  deps: EgressApplyDeps,
  scope: string,
  host: string,
): Promise<ApplyOutcome> {
  return withConflictDomains([egressScopeDomain(scope)], () => {
    try {
      if (scope === EGRESS_GLOBAL_SCOPE && isBuiltinDefault(host)) {
        deps.egressAllowlistStore.suppressDefault(host);
      } else {
        deps.egressAllowlistStore.removeHost(scope, host);
      }
    } catch (err) {
      console.error(`[settings-apply] removing egress host ${host} from ${scope} failed:`, err);
      return outcomeOf(err);
    }
    deps.broadcastEgressSettings?.();
    broadcastSettingsChanged(deps, ["network.egress.hosts"]);
    return APPLIED;
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
  status: T;
  outcome: ApplyOutcome;
}

/**
 * `setChannel` writes the channel and then calls `checkForUpdates`, which can
 * throw after the write has landed — so a throw from the second half is not a
 * failed write, and reporting it as one would tell the user their channel did
 * not change when it did.
 */
export async function applyReleaseChannel(
  deps: SettingsBroadcastDeps,
  channel: "stable" | "edge",
): Promise<ReleaseChannelWriteResult<Awaited<ReturnType<typeof setChannel>> | null>> {
  return withConflictDomains([releaseChannelDomain], async () => {
    try {
      const status = await setChannel(channel);
      broadcastSettingsChanged(deps, ["advanced.releaseChannel"]);
      return { status, outcome: APPLIED };
    } catch (err) {
      if (err instanceof ServiceError && err.statusCode !== 500) throw err;
      broadcastSettingsChanged(deps, ["advanced.releaseChannel"]);
      // Which half failed is not something the error says, and guessing would
      // report a channel that did move as unchanged. What is on disk says it.
      const stored = await readChannel().catch(() => null);
      const detail = `ShipIt could not complete the release channel change: ${getErrorMessage(err)}`;
      return {
        status: null,
        outcome: stored === channel
          ? applyUncertain(`The channel was set to ${channel}. ${detail}`)
          : applyFailed(`The channel is still ${stored ?? "unchanged"}. ${detail}`),
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
        // Revoke before cancellation; the executor rechecks the grant if cancellation fails.
        if (!patch.allowAgentMerge) cancelAgentMergeRequests(deps, repoId(url) ?? "");
        outcomes.push(APPLIED);
        keys.push("project.allowAgentMerge");
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
