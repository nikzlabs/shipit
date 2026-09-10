import path from "node:path";
import { revokeOpenCodeSource } from "../openai-account-delivery.js";

import type { CredentialStore } from "../credential-store.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";
import { isAllowedAgentEnvKey } from "../../shared/agent-registry.js";
import type { AccountSelectionMode, AgentId, CredentialRoute, FailoverCutoffs } from "../../shared/types.js";
import { credentialModeKey, DEFAULT_FAILOVER_CUTOFF, DEFAULT_SELECTION_MODE, parseCredentialModeKey } from "../../shared/types.js";
import { allServices, credentialModeForStorageEnv, getMode, getModel, getService, loginIntegrationForService, nativeServiceForHarness } from "../../shared/catalogue/index.js";
import { firstEligibleNonTurnSelection, harnessForNonTurnSelection, resolveNonTurnModel } from "../non-turn-model.js";
import { listConfiguredCredentials } from "../service-routing.js";
import { listCredentialRoutes, upsertSingleStringCredential } from "./credential-routes.js";
import type { VoiceDeliveryMode } from "../../shared/types/voice-note-types.js";
import { getGitIdentity, setGitIdentity as writeGitIdentity } from "../git-config.js";
import { buildAgentSystemInstructions } from "../agent-instructions.js";
import { readGlobalSystemPrompt, writeGlobalSystemPrompt } from "../global-system-prompt.js";
import { ServiceError } from "./types.js";
import type { AgentInfo, GlobalSettings, NonTurnModelResolved, NonTurnModelSelection, ReviewerPinPatch, ReviewerSlotView } from "./types.js";
import type { ReviewerPin, ReviewerSlot, RoleView } from "../../shared/types/agent-types.js";
import {
  buildReviewerSettings,
  parseReviewerPinPatch,
  requireReviewerSlot,
  resolveReviewerPinPatch,
} from "./reviewer-settings.js";
import { buildRoleSettings } from "./roles.js";
import { applyRoleWrites } from "./role-settings.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "../session-runner.js";
import { readSessionAccountMarker } from "../session-credentials.js";
import { revokeSessionProviderCredentials } from "../session-agent-credentials.js";

export function computeCanRunTurns(agentRegistry: AgentRegistry): boolean {
  return agentRegistry.list().some((a) => a.installed && a.hasRunnableModels);
}

// Stamp on read to cover existing installs and every credential entry path.
export function resolveHarnessOnboarding(
  agentRegistry: AgentRegistry,
  credentialStore: CredentialStore | undefined,
): { canRunTurns: boolean; harnessOnboardingCompletedAt?: string } {
  const canRunTurns = computeCanRunTurns(agentRegistry);
  const existing = credentialStore?.getHarnessOnboardingCompletedAt();
  if (existing) return { canRunTurns, harnessOnboardingCompletedAt: existing };
  if (!canRunTurns || !credentialStore) return { canRunTurns };
  const stamped = credentialStore.stampHarnessOnboardingCompleted(new Date().toISOString());
  return stamped ? { canRunTurns, harnessOnboardingCompletedAt: stamped } : { canRunTurns };
}

export function seedNonTurnModel(
  credentialStore: CredentialStore | undefined,
  agentRegistry: AgentRegistry,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!credentialStore) return;
  if (credentialStore.getNonTurnModel()) return;
  // A permanent seed needs a confirmed installation and completed account login.
  const installed = new Set(agentRegistry.list().filter((a) => a.installed).map((a) => a.id));
  const first = firstEligibleNonTurnSelection(
    listConfiguredCredentials(credentialStore, env, { requireReadyAccounts: true }),
    { isInstalled: (harnessId) => installed.has(harnessId) },
  );
  if (!first) return;
  credentialStore.stampNonTurnModel(first.selection);
}

export function buildNonTurnModelSettings(
  agentRegistry: AgentRegistry,
  credentialStore: CredentialStore | undefined,
  providerAccountManager: ProviderAccountManager | undefined,
): { nonTurnModel?: NonTurnModelSelection; nonTurnModelResolved?: NonTurnModelResolved } {
  seedNonTurnModel(credentialStore, agentRegistry);
  const nonTurnModel = credentialStore?.getNonTurnModel();
  const resolution = credentialStore
    ? resolveNonTurnModel({
        credentialStore,
        ...(providerAccountManager ? { providerAccountManager } : {}),
      })
    : undefined;
  const nonTurnModelResolved: NonTurnModelResolved | undefined = resolution?.ok
    ? {
        serviceId: resolution.target.selection.serviceId,
        billingMode: resolution.target.selection.billingMode,
        modelId: resolution.target.selection.modelId,
        serviceName: resolution.target.serviceName,
        label: getModel(resolution.target.selection)?.label ?? resolution.target.selection.modelId,
        harnessId: resolution.target.harnessId,
        source: resolution.target.source,
      }
    : undefined;
  return {
    ...(nonTurnModel ? { nonTurnModel } : {}),
    ...(nonTurnModelResolved ? { nonTurnModelResolved } : {}),
  };
}

/** Shared agent_list payload so credential changes refresh all derived settings. */
export function buildAgentListPayload(
  agentRegistry: AgentRegistry,
  credentialStore: CredentialStore | undefined,
  providerAccountManager: ProviderAccountManager | undefined,
): {
  agents: AgentInfo[];
  canRunTurns: boolean;
  harnessOnboardingCompletedAt?: string;
  reviewers: ReviewerSlotView[];
  roles: RoleView[];
  nonTurnModel: NonTurnModelSelection | null;
  nonTurnModelResolved: NonTurnModelResolved | null;
} {
  const nonTurn = buildNonTurnModelSettings(agentRegistry, credentialStore, providerAccountManager);
  return {
    agents: listAgents(agentRegistry),
    ...resolveHarnessOnboarding(agentRegistry, credentialStore),
    reviewers: buildReviewerSettings({ credentialStore, providerAccountManager }),
    roles: credentialStore
      ? buildRoleSettings({
          credentialStore,
          ...(providerAccountManager ? { providerAccountManager } : {}),
        })
      : [],
    // Omission preserves client state; null explicitly clears stale values.
    nonTurnModel: nonTurn.nonTurnModel ?? null,
    nonTurnModelResolved: nonTurn.nonTurnModelResolved ?? null,
  };
}

export function listAgents(agentRegistry: AgentRegistry): AgentInfo[] {
  return agentRegistry.list().map((a) => ({
    id: a.id,
    name: a.name,
    installed: a.installed,
    hasRunnableModels: a.hasRunnableModels,
    models: a.capabilities.models,
    eligibleModels: a.eligibleModels,
    supportsReview: a.capabilities.supportsReview,
    supportsSteering: a.capabilities.supportsSteering,
    supportsCompaction: a.capabilities.supportsCompaction,
    supportedPermissionModes: a.capabilities.supportedPermissionModes,
    skillInvocationPrefix: a.capabilities.skillInvocationPrefix,
    ...(a.capabilities.reasoning ? { reasoning: a.capabilities.reasoning } : {}),
  }));
}

export async function getGlobalSettings(
  agentRegistry: AgentRegistry,
  appWorkspaceDir: string,
  credentialStore?: CredentialStore,
  providerAccountManager?: ProviderAccountManager,
): Promise<GlobalSettings> {
  const stored = getGitIdentity();
  const gitIdentity = stored
    ? { name: stored.name, email: stored.email }
    : { name: "", email: "" };

  const systemPrompt = (await readGlobalSystemPrompt(appWorkspaceDir)) ?? "";

  const agents = listAgents(agentRegistry);
  const memoryBudgetMb = credentialStore?.getMemoryBudgetMb() ?? null;
  const agentSystemInstructionsEnabled = credentialStore?.getAgentSystemInstructionsEnabled() ?? true;
  const autoCreatePr = credentialStore?.getAutoCreatePr() ?? false;
  const liveSteering = credentialStore?.getLiveSteering() ?? true;
  const autoResolveConflicts = credentialStore?.getAutoResolveConflicts() ?? false;
  const autoFixCi = credentialStore?.getAutoFixCi() ?? false;
  const autoResetMergedBranch = credentialStore?.getAutoResetMergedBranch() ?? true;
  const enableSubAgents = credentialStore?.getEnableSubAgents() ?? true;
  const previewAgent = agentRegistry.available()[0] ?? agentRegistry.list()[0];
  const agentSystemInstructions = previewAgent
    ? buildAgentSystemInstructions({ agentId: previewAgent.id })
    : "";
  const providerAccounts = providerAccountManager?.list() ?? [];
  const voiceDeliveryMode = credentialStore?.getVoiceDeliveryMode() ?? "native";
  const voiceWebhookConfigured = !!credentialStore?.getVoiceWebhook();
  const failoverCutoffs: Record<string, FailoverCutoffs> = {};
  const accountSelectionMode: Record<string, AccountSelectionMode> = {};
  for (const service of allServices()) {
    for (const mode of service.modes) {
      if (mode.kind !== "sub") continue;
      const key = credentialModeKey(service.id, mode.kind);
      failoverCutoffs[key] = credentialStore?.getFailoverCutoffs(service.id, mode.kind)
        ?? { session: DEFAULT_FAILOVER_CUTOFF, weekly: DEFAULT_FAILOVER_CUTOFF };
      accountSelectionMode[key] = credentialStore?.getSelectionMode(service.id, mode.kind)
        ?? DEFAULT_SELECTION_MODE;
    }
  }
  const { canRunTurns, harnessOnboardingCompletedAt } =
    resolveHarnessOnboarding(agentRegistry, credentialStore);
  const credentialRoutes = credentialStore ? listCredentialRoutes(credentialStore) : [];
  const { nonTurnModel, nonTurnModelResolved } =
    buildNonTurnModelSettings(agentRegistry, credentialStore, providerAccountManager);
  const reviewers = buildReviewerSettings({ credentialStore, providerAccountManager });
  const roles = credentialStore
    ? buildRoleSettings({ credentialStore, ...(providerAccountManager ? { providerAccountManager } : {}) })
    : [];
  return { canRunTurns, harnessOnboardingCompletedAt, failoverCutoffs, accountSelectionMode, gitIdentity, systemPrompt, agents, memoryBudgetMb, agentSystemInstructionsEnabled, agentSystemInstructions, autoCreatePr, liveSteering, autoResolveConflicts, autoFixCi, autoResetMergedBranch, enableSubAgents, voiceDeliveryMode, voiceWebhookConfigured, providerAccounts, credentialRoutes, reviewers, roles,
    ...(nonTurnModel ? { nonTurnModel } : {}),
    ...(nonTurnModelResolved ? { nonTurnModelResolved } : {}) };
}

export function setGitIdentityService(
  name: string,
  email: string,
): { name: string; email: string } {
  const trimmedName = name.trim();
  const trimmedEmail = email.trim();
  if (!trimmedName) throw new ServiceError(400, "Git user name cannot be empty");
  if (!trimmedEmail) throw new ServiceError(400, "Git email cannot be empty");
  if (trimmedName.length > 200) throw new ServiceError(400, "Git user name is too long (max 200 characters)");
  if (trimmedEmail.length > 200) throw new ServiceError(400, "Git email is too long (max 200 characters)");
  writeGitIdentity(trimmedName, trimmedEmail);
  return { name: trimmedName, email: trimmedEmail };
}

export interface SaveGlobalSettingsOptions {
  agentRegistry: AgentRegistry;
  /** Orchestrator workspace containing the global system prompt. */
  appWorkspaceDir: string;
  credentialStore: CredentialStore;
  providerAccountManager?: ProviderAccountManager;
  onAutoResolveConflictsEnabled?: () => void;
  onAutoFixCiEnabled?: () => void;
  gitIdentity?: { name: string; email: string };
  systemPrompt?: string;
  /** null restores the host-derived budget. */
  memoryBudgetMb?: number | null;
  agentSystemInstructionsEnabled?: boolean;
  autoCreatePr?: boolean;
  liveSteering?: boolean;
  autoResolveConflicts?: boolean;
  autoFixCi?: boolean;
  autoResetMergedBranch?: boolean;
  enableSubAgents?: boolean;
  failoverCutoffs?: Record<string, Partial<FailoverCutoffs>>;
  accountSelectionMode?: Record<string, AccountSelectionMode>;
  voiceDeliveryMode?: VoiceDeliveryMode;
  nonTurnModel?: NonTurnModelSelection | null;
  reviewers?: Record<string, unknown>;
  roles?: Record<string, unknown>;
}

export async function saveGlobalSettings(
  opts: SaveGlobalSettingsOptions,
): Promise<GlobalSettings> {
  const {
    agentRegistry, appWorkspaceDir, credentialStore, providerAccountManager,
    onAutoResolveConflictsEnabled,
    gitIdentity, systemPrompt, memoryBudgetMb,
    agentSystemInstructionsEnabled, autoCreatePr, liveSteering,
    autoResolveConflicts, autoFixCi, autoResetMergedBranch, enableSubAgents, voiceDeliveryMode,
    failoverCutoffs, accountSelectionMode, nonTurnModel, reviewers, roles,
  } = opts;

  if (gitIdentity) {
    const name = typeof gitIdentity.name === "string" ? gitIdentity.name.trim() : "";
    const email = typeof gitIdentity.email === "string" ? gitIdentity.email.trim() : "";
    if (!name) throw new ServiceError(400, "Git user name cannot be empty");
    if (!email) throw new ServiceError(400, "Git email cannot be empty");
    if (name.length > 200) throw new ServiceError(400, "Git user name is too long (max 200 characters)");
    if (email.length > 200) throw new ServiceError(400, "Git email is too long (max 200 characters)");
    writeGitIdentity(name, email);
  }

  if (systemPrompt !== undefined) {
    const content = typeof systemPrompt === "string" ? systemPrompt : "";
    if (content.length > 50_000) throw new ServiceError(400, "System prompt too long (max 50,000 characters)");
    await writeGlobalSystemPrompt(appWorkspaceDir, content);
  }

  if (memoryBudgetMb !== undefined) {
    credentialStore.setMemoryBudgetMb(
      memoryBudgetMb === null ? null : Math.max(0, Math.floor(memoryBudgetMb)),
    );
  }

  if (agentSystemInstructionsEnabled !== undefined) {
    credentialStore.setAgentSystemInstructionsEnabled(agentSystemInstructionsEnabled);
  }

  if (autoCreatePr !== undefined) {
    credentialStore.setAutoCreatePr(autoCreatePr);
  }

  if (liveSteering !== undefined) {
    credentialStore.setLiveSteering(liveSteering);
  }

  if (enableSubAgents !== undefined) {
    credentialStore.setEnableSubAgents(enableSubAgents);
  }

  if (failoverCutoffs !== undefined) {
    for (const [key, patch] of Object.entries(failoverCutoffs)) {
      const target = requireSubscriptionModeKey(key);
      for (const window of ["session", "weekly"] as const) {
        const value = patch[window];
        if (value === undefined) continue;
        if (!Number.isInteger(value) || value < 1 || value > 100) {
          throw new ServiceError(400, `${window} failover cutoff must be an integer between 1 and 100`);
        }
      }
      credentialStore.setFailoverCutoffs(target.serviceId, target.billingMode, patch);
    }
  }

  if (accountSelectionMode !== undefined) {
    for (const [key, mode] of Object.entries(accountSelectionMode)) {
      const target = requireSubscriptionModeKey(key);
      if (mode !== "strict" && mode !== "balanced") {
        throw new ServiceError(400, `Account selection mode must be "strict" or "balanced"`);
      }
      credentialStore.setSelectionMode(target.serviceId, target.billingMode, mode);
    }
  }

  if (nonTurnModel !== undefined) {
    if (nonTurnModel === null) {
      // Older clients send null; reseed once when a runnable selection exists.
      credentialStore.setNonTurnModel(null);
      seedNonTurnModel(credentialStore, agentRegistry);
    } else {
      const runnable = harnessForNonTurnSelection(
        nonTurnModel,
        listConfiguredCredentials(credentialStore),
      );
      if (!runnable) {
        throw new ServiceError(
          400,
          `No installed harness can run ${nonTurnModel.serviceId}/${nonTurnModel.billingMode}/${nonTurnModel.modelId} with the credentials configured`,
        );
      }
      credentialStore.setNonTurnModel(nonTurnModel);
    }
  }

  // Validate all slots before writing any, so a bad second slot cannot partly save.
  if (reviewers !== undefined) {
    if (reviewers === null || typeof reviewers !== "object" || Array.isArray(reviewers)) {
      throw new ServiceError(400, "reviewers must be an object keyed by reviewer slot");
    }
    const resolved: [ReviewerSlot, ReviewerPin | null][] = Object.entries(reviewers).map(
      ([slot, raw]) => {
        const patch: ReviewerPinPatch | null = parseReviewerPinPatch(raw, slot);
        return [
          requireReviewerSlot(slot),
          patch === null ? null : resolveReviewerPinPatch(patch, credentialStore),
        ];
      },
    );
    for (const [slot, pin] of resolved) credentialStore.setReviewerPin(slot, pin);
  }

  if (roles !== undefined) {
    applyRoleWrites(roles, credentialStore, { credentialStore });
  }

  if (voiceDeliveryMode !== undefined) {
    credentialStore.setVoiceDeliveryMode(voiceDeliveryMode);
  }

  // Enabling remediation refreshes existing snapshots without waiting for a PR change.
  if (autoResolveConflicts !== undefined) {
    const prev = credentialStore.getAutoResolveConflicts();
    credentialStore.setAutoResolveConflicts(autoResolveConflicts);
    if (!prev && autoResolveConflicts) onAutoResolveConflictsEnabled?.();
  }

  if (autoFixCi !== undefined) {
    const prev = credentialStore.getAutoFixCi();
    credentialStore.setAutoFixCi(autoFixCi);
    if (!prev && autoFixCi) opts.onAutoFixCiEnabled?.();
  }

  if (autoResetMergedBranch !== undefined) {
    credentialStore.setAutoResetMergedBranch(autoResetMergedBranch);
  }

  return getGlobalSettings(agentRegistry, appWorkspaceDir, credentialStore, providerAccountManager);
}

export function setAgent(
  agentRegistry: AgentRegistry,
  agentId: AgentId,
): { agentId: AgentId } {
  const info = agentRegistry.get(agentId);
  if (!info) throw new ServiceError(400, `Unknown agent: ${agentId}`);
  if (!info.installed) throw new ServiceError(400, `${info.name} CLI is not installed in this environment`);
  if (!info.hasRunnableModels) {
    throw new ServiceError(
      400,
      `${info.name} has no models available. Add a credential for a service it can reach in Settings → Services.`,
    );
  }
  return { agentId };
}

export function setAgentEnv(
  agentRegistry: AgentRegistry,
  credentialStore: CredentialStore,
  agentId: AgentId,
  key: string,
  value: string,
): { agentId: AgentId; key: string; agents: AgentInfo[]; route?: CredentialRoute } {
  if (!agentId || !key || typeof value !== "string") {
    throw new ServiceError(400, "Invalid set_agent_env request");
  }
  if (!isAllowedAgentEnvKey(key)) {
    throw new ServiceError(400, `Environment variable ${key} is not in the allowlist`);
  }
  if (value.trim().length === 0) {
    throw new ServiceError(400, "Value cannot be empty");
  }
  process.env[key] = value;
  const owner = credentialModeForStorageEnv(key);
  const route = owner
    ? upsertSingleStringCredential(credentialStore, owner.serviceId, owner.billingMode, value)
    : undefined;
  if (!owner) credentialStore.setAgentEnv(key, value);
  agentRegistry.refreshAuth(agentId);
  return { agentId, key, agents: listAgents(agentRegistry), ...(route ? { route } : {}) };
}

export function setApiKey(credentialStore: CredentialStore, key: string): void {
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (!trimmed) throw new ServiceError(400, "API key cannot be empty");
  if (!trimmed.startsWith("sk-ant-")) throw new ServiceError(400, "Invalid API key format");
  upsertSingleStringCredential(credentialStore, "anthropic", "key", trimmed);
  process.env.ANTHROPIC_API_KEY = trimmed;
}

export function clearApiKey(credentialStore: CredentialStore): void {
  for (const route of credentialStore.listCredentialRoutes("anthropic", "key")) {
    if (route.via === "string") credentialStore.deleteCredentialRoute(route.id);
  }
  delete process.env.ANTHROPIC_API_KEY;
}

export function listProviderAccounts(providerAccountManager: ProviderAccountManager): { accounts: CredentialRoute[] } {
  return { accounts: providerAccountManager.list() };
}

export function createProviderAccount(
  providerAccountManager: ProviderAccountManager,
  provider: AgentId,
  label?: string,
): { account: CredentialRoute; accounts: CredentialRoute[] } {
  const serviceId = requireAccountService(provider);
  const account = providerAccountManager.create(serviceId, label);
  return { account, accounts: providerAccountManager.list() };
}

export function renameProviderAccount(
  providerAccountManager: ProviderAccountManager,
  provider: AgentId,
  accountId: string,
  label: string,
): { account: CredentialRoute; accounts: CredentialRoute[] } {
  const serviceId = requireAccountService(provider);
  validateAccountId(accountId);
  try {
    const account = providerAccountManager.rename(serviceId, accountId, label);
    return { account, accounts: providerAccountManager.list() };
  } catch (err) {
    throw providerAccountServiceError(err);
  }
}

export function reorderProviderAccounts(
  providerAccountManager: ProviderAccountManager,
  provider: AgentId,
  accountIds: unknown,
): { accounts: CredentialRoute[] } {
  const serviceId = requireAccountService(provider);
  if (!Array.isArray(accountIds) || accountIds.some((id) => typeof id !== "string" || !id)) {
    throw new ServiceError(400, "accountIds must be an array of account ids");
  }
  for (const id of accountIds as string[]) validateAccountId(id);
  try {
    providerAccountManager.reorder(serviceId, accountIds as string[]);
    return { accounts: providerAccountManager.list() };
  } catch (err) {
    throw providerAccountServiceError(err);
  }
}

function runnerBusy(runner: SessionRunnerInterface): boolean {
  return runner.running || runner.backgroundWorkDescriptions.length > 0;
}

// Prefer the live process route; markers cover processes adopted after restart.
function runnerOnAccount(
  runner: SessionRunnerInterface,
  provider: AgentId,
  accountIds: ReadonlySet<string>,
  credentialsDir: string | undefined,
): boolean {
  if (runner.residentRoute) {
    return runner.residentRoute.kind === "account" && accountIds.has(runner.residentRoute.id);
  }
  if (!credentialsDir) return false;
  const markers = readSessionAccountMarker(credentialsDir, runner.sessionId);
  const recorded = markers[provider];
  return (recorded !== undefined && accountIds.has(recorded)) || (provider === "codex" && markers.opencode !== undefined && accountIds.has(markers.opencode));
}

function busySessionsOnAccounts(
  runnerRegistry: SessionRunnerRegistry,
  provider: AgentId,
  accountIds: ReadonlySet<string>,
  credentialsDir: string | undefined,
): string[] {
  return runnerRegistry.ids().filter((sessionId) => {
    const runner = runnerRegistry.get(sessionId);
    return !!runner && runnerBusy(runner) && runnerOnAccount(runner, provider, accountIds, credentialsDir);
  });
}

// Call after the busy guard and before disk revocation: resident CLIs retain tokens.
function retireResidentProcessesOnAccounts(
  runnerRegistry: SessionRunnerRegistry,
  provider: AgentId,
  accountIds: ReadonlySet<string>,
  credentialsDir: string | undefined,
): void {
  for (const sessionId of runnerRegistry.ids()) {
    const runner = runnerRegistry.get(sessionId);
    if (!runner || !runnerOnAccount(runner, provider, accountIds, credentialsDir)) continue;
    const agent = runner.getAgent();
    if (!agent) continue;
    try {
      agent.kill();
    } catch {
      // Continue revoking disk copies if the process handle is stale.
    }
    runner.setAgent(null);
  }
}

// Match account markers, not token bytes, which the CLI can rotate.
function revokeRecordedAccountCopies(
  sessionManager: SessionManager,
  provider: AgentId,
  accountIds: ReadonlySet<string>,
  credentialsDir: string | undefined,
  context: string,
): void {
  if (!credentialsDir) {
    console.warn(`[provider-accounts] no credentialsDir: sessions keep their copies of ${context}`);
    return;
  }
  if (provider === "codex") {
    for (const id of accountIds) revokeOpenCodeSource(path.join(credentialsDir, "provider-accounts", "codex", id));
  }
  for (const session of sessionManager.listAll()) {
    if (provider === "codex") {
      const consumerAccount = readSessionAccountMarker(credentialsDir, session.id).opencode;
      if (consumerAccount && accountIds.has(consumerAccount)) revokeSessionProviderCredentials(credentialsDir, session.id, "opencode");
    }
    const recorded = readSessionAccountMarker(credentialsDir, session.id)[provider];
    if (recorded !== undefined && accountIds.has(recorded)) {
      revokeSessionProviderCredentials(credentialsDir, session.id, provider);
    }
  }
}

export function signOutProvider(
  providerAccountManager: ProviderAccountManager,
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  provider: AgentId,
  opts: { credentialsDir?: string } = {},
): void {
  const serviceId = requireAccountService(provider);
  const signedOut = new Set(
    providerAccountManager.list(serviceId).map((account) => account.id),
  );

  const busy = busySessionsOnAccounts(runnerRegistry, provider, signedOut, opts.credentialsDir);
  if (busy.length > 0) {
    throw new ServiceError(
      409,
      `Cannot sign out of ${provider} while ${busy.length} session(s) are mid-turn or running background work on a connected account.`,
    );
  }

  retireResidentProcessesOnAccounts(runnerRegistry, provider, signedOut, opts.credentialsDir);
  revokeRecordedAccountCopies(
    sessionManager,
    provider,
    signedOut,
    opts.credentialsDir,
    `signed-out ${provider} accounts`,
  );

  providerAccountManager.signOutProvider(provider);
}

export function deleteProviderAccount(
  providerAccountManager: ProviderAccountManager,
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  provider: AgentId,
  accountId: string,
  opts: { credentialsDir?: string } = {},
): { accounts: CredentialRoute[] } {
  const serviceId = requireAccountService(provider);
  validateAccountId(accountId);
  const { credentialsDir } = opts;
  const accountIds = new Set([accountId]);

  const busy = busySessionsOnAccounts(runnerRegistry, provider, accountIds, credentialsDir);
  if (busy.length > 0) {
    const named = busy
      .slice(0, 3)
      .map((sessionId) => `"${sessionManager.get(sessionId)?.title || sessionId}"`)
      .join(", ");
    const rest = busy.length - Math.min(busy.length, 3);
    throw new ServiceError(
      409,
      `Cannot disconnect this account while sessions are still working on it: ${named}${rest > 0 ? ` and ${rest} more` : ""}. `
        + "Wait for them to finish or stop them, then disconnect.",
    );
  }

  retireResidentProcessesOnAccounts(runnerRegistry, provider, accountIds, credentialsDir);
  revokeRecordedAccountCopies(
    sessionManager,
    provider,
    accountIds,
    credentialsDir,
    `disconnected ${provider} account ${accountId}`,
  );

  try {
    providerAccountManager.delete(serviceId, accountId);
    return { accounts: providerAccountManager.list() };
  } catch (err) {
    throw providerAccountServiceError(err);
  }
}

export function startProviderAccountLogin(
  providerAccountManager: ProviderAccountManager,
  provider: AgentId,
  accountId: string,
): { account: CredentialRoute; accounts: CredentialRoute[] } {
  const serviceId = requireAccountService(provider);
  validateAccountId(accountId);
  try {
    const account = providerAccountManager.startAccountAuth(serviceId, accountId);
    return { account, accounts: providerAccountManager.list() };
  } catch (err) {
    throw providerAccountServiceError(err);
  }
}

export function cancelProviderAccountLogin(
  providerAccountManager: ProviderAccountManager,
  provider: AgentId,
  accountId: string,
): { account: CredentialRoute; accounts: CredentialRoute[] } {
  const serviceId = requireAccountService(provider);
  validateAccountId(accountId);
  try {
    const account = providerAccountManager.cancelAccountAuth(serviceId, accountId);
    return { account, accounts: providerAccountManager.list() };
  } catch (err) {
    throw providerAccountServiceError(err);
  }
}

export function submitProviderAccountCode(
  providerAccountManager: ProviderAccountManager,
  provider: AgentId,
  accountId: string,
  code: string,
): void {
  const serviceId = requireAccountService(provider);
  validateAccountId(accountId);
  const trimmed = typeof code === "string" ? code.trim() : "";
  if (!trimmed) throw new ServiceError(400, "Authorization code cannot be empty");
  try {
    providerAccountManager.submitAccountCode(serviceId, accountId, trimmed);
  } catch (err) {
    throw providerAccountServiceError(err);
  }
}

function requireSubscriptionModeKey(key: string): { serviceId: string; billingMode: "sub" } {
  const parsed = parseCredentialModeKey(key);
  if (!parsed) throw new ServiceError(400, `Malformed credential mode key: ${key}`);
  if (!getService(parsed.serviceId)) throw new ServiceError(400, `Unknown service: ${parsed.serviceId}`);
  if (parsed.billingMode !== "sub") {
    throw new ServiceError(400, `Routing settings apply to subscriptions only, not to ${key}`);
  }
  if (!getMode(parsed.serviceId, "sub")) {
    throw new ServiceError(400, `${parsed.serviceId} has no subscription mode`);
  }
  return { serviceId: parsed.serviceId, billingMode: "sub" };
}

function requireAccountService(provider: AgentId): string {
  if (provider !== "claude" && provider !== "codex" && provider !== "opencode" && provider !== "grok") {
    throw new ServiceError(400, "Unknown provider");
  }
  // A native service can use keys without supporting account login.
  const serviceId = nativeServiceForHarness(provider);
  if (!serviceId || !loginIntegrationForService(serviceId)) {
    throw new ServiceError(400, "Unknown provider");
  }
  return serviceId;
}

function validateAccountId(accountId: string): void {
  if (typeof accountId !== "string" || !accountId.trim()) {
    throw new ServiceError(400, "Provider account id is required");
  }
}

function providerAccountServiceError(err: unknown): ServiceError {
  const message = err instanceof Error ? err.message : "Provider account operation failed";
  if (/not found/i.test(message)) return new ServiceError(404, message);
  if (/empty|too long/i.test(message)) return new ServiceError(400, message);
  if (/already signing in|no longer running/i.test(message)) return new ServiceError(409, message);
  return new ServiceError(500, message);
}
