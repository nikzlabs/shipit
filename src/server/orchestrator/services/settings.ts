import path from "node:path";
import { revokeOpenCodeSource } from "../openai-account-delivery.js";

import type { CredentialStore } from "../credential-store.js";
import type { AgentRegistry, EligibleModel } from "../../shared/agent-registry.js";
import { isAllowedAgentEnvKey } from "../../shared/agent-registry.js";
import type { AccountSelectionMode, AgentId, CredentialRoute, FailoverCutoffs } from "../../shared/types.js";
import { credentialModeKey, DEFAULT_FAILOVER_CUTOFF, DEFAULT_SELECTION_MODE, parseCredentialModeKey } from "../../shared/types.js";
import { allHarnesses, allServices, credentialModeForStorageEnv, getMode, getModel, getService, loginIntegrationForService, nativeServiceForHarness } from "../../shared/catalogue/index.js";
import { backgroundWorkOptions, firstEligibleNonTurnSelection, resolveNonTurnModel, runnerForNonTurnSelection } from "../non-turn-model.js";
import { listConfiguredCredentials } from "../service-routing.js";
import { listCredentialRoutes, upsertSingleStringCredential } from "./credential-routes.js";
import { setGitIdentity as writeGitIdentity } from "../git-config.js";
import { buildAgentSystemInstructions } from "../agent-instructions.js";
import { combineOutcomes, GLOBAL_SETTINGS } from "../../shared/settings-catalogue/index.js";
import type { ApplyOutcome, GlobalSettingKey, GlobalSettingsPatch } from "../../shared/settings-catalogue/index.js";
import {
  currentDeclaredValue,
  readStoredGlobalSettings,
  validateDeclaredSettings,
  writeDeclaredSetting,
} from "./settings-derivation.js";
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
import { planRoleWrites } from "./role-settings.js";
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

/**
 * The model an unpinned install would be seeded with, or nothing.
 *
 * Read by the seeding below AND by the proposal that would clear the pin
 * (`settings-operations.ts`): where this answers a selection, "not set" is not
 * a state the setting can be left in, and a card promising it would be
 * contradicted by its own write (docs/299-agent-settings-access req 4). One
 * function so the refusal and the seed cannot come to different answers.
 */
export function nonTurnModelSeedCandidate(
  credentialStore: CredentialStore | undefined,
  agentRegistry: AgentRegistry,
  env: NodeJS.ProcessEnv = process.env,
): NonTurnModelSelection | undefined {
  if (!credentialStore) return undefined;
  // A permanent seed needs a confirmed installation and completed account login.
  const installed = new Set(agentRegistry.list().filter((a) => a.installed).map((a) => a.id));
  return firstEligibleNonTurnSelection(
    listConfiguredCredentials(credentialStore, env, { requireReadyAccounts: true }),
    { isInstalled: (harnessId) => installed.has(harnessId) },
  )?.selection;
}

export function seedNonTurnModel(
  credentialStore: CredentialStore | undefined,
  agentRegistry: AgentRegistry,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!credentialStore) return;
  if (credentialStore.getNonTurnModel()) return;
  const first = nonTurnModelSeedCandidate(credentialStore, agentRegistry, env);
  if (!first) return;
  credentialStore.stampNonTurnModel(first);
}

export function buildNonTurnModelSettings(
  agentRegistry: AgentRegistry,
  credentialStore: CredentialStore | undefined,
  providerAccountManager: ProviderAccountManager | undefined,
): {
  nonTurnModel?: NonTurnModelSelection;
  nonTurnModelResolved?: NonTurnModelResolved;
  backgroundWorkModels: EligibleModel[];
} {
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
        execution: resolution.target.execution,
        ...(resolution.target.execution === "harness"
          ? { harnessId: resolution.target.harnessId }
          : {}),
        source: resolution.target.source,
      }
    : undefined;
  return {
    ...(nonTurnModel ? { nonTurnModel } : {}),
    ...(nonTurnModelResolved ? { nonTurnModelResolved } : {}),
    backgroundWorkModels: backgroundWorkModelOptions(agentRegistry, credentialStore),
  };
}

// The harness half still needs an installed harness; the direct half needs none.
function backgroundWorkModelOptions(
  agentRegistry: AgentRegistry,
  credentialStore: CredentialStore | undefined,
): EligibleModel[] {
  if (!credentialStore) return [];
  const installed = new Set(agentRegistry.list().filter((a) => a.installed).map((a) => a.id));
  return backgroundWorkOptions(listConfiguredCredentials(credentialStore), {
    isInstalled: (harnessId) => installed.has(harnessId),
  });
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
  backgroundWorkModels: EligibleModel[];
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
    backgroundWorkModels: nonTurn.backgroundWorkModels,
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
    supportsGoals: a.capabilities.supportsGoals ?? false,
    ...(a.capabilities.goalActions ? { goalActions: a.capabilities.goalActions } : {}),
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
  // Seeds the pin before the stored half is read, so a first read returns it.
  const { nonTurnModelResolved, backgroundWorkModels } =
    buildNonTurnModelSettings(agentRegistry, credentialStore, providerAccountManager);
  // The dialog needs a complete payload, so a setting ShipIt could not read
  // renders as its declared default here. The agent's read surface is the one
  // that must not do that (`settings-read.ts`, docs/299 req 1).
  const { values: storedSettings } = await readStoredGlobalSettings({
    appWorkspaceDir,
    ...(credentialStore ? { credentialStore } : {}),
  });

  const agents = listAgents(agentRegistry);
  const previewAgent = agentRegistry.available()[0] ?? agentRegistry.list()[0];
  const agentSystemInstructions = previewAgent
    ? buildAgentSystemInstructions({ agentId: previewAgent.id })
    : "";
  const providerAccounts = providerAccountManager?.list() ?? [];
  const voiceWebhookConfigured = !!credentialStore?.getVoiceWebhook();
  // Addressed per service rather than stored once, so the catalogue does not
  // carry them yet — they land with the target-addressed settings (docs/299).
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
  const reviewers = buildReviewerSettings({ credentialStore, providerAccountManager });
  const roles = credentialStore
    ? buildRoleSettings({ credentialStore, ...(providerAccountManager ? { providerAccountManager } : {}) })
    : [];
  return { ...storedSettings, canRunTurns, harnessOnboardingCompletedAt, failoverCutoffs, accountSelectionMode, agents, agentSystemInstructions, voiceWebhookConfigured, providerAccounts, credentialRoutes, reviewers, roles, backgroundWorkModels,
    ...(nonTurnModelResolved ? { nonTurnModelResolved } : {}) };
}

interface SaveHookContext {
  agentRegistry: AgentRegistry;
  credentialStore: CredentialStore;
  onAutoResolveConflictsEnabled?: () => void;
  onAutoFixCiEnabled?: () => void;
  onSessionStatusCardEnabled?: () => void;
  /** docs/303 req 21 — fires in both directions: the tool list is fixed at spawn. */
  onSessionStatusCardToggled?: (enabled: boolean) => void;
}

/**
 * What saving a setting does beyond storing it. A declaration says what a
 * setting is; anything else the write has to do lives here, keyed by the
 * declared key — so an ordinary setting needs no entry (docs/299 req 7).
 */
interface SaveHook {
  /** Refuse a value for a reason the declared type cannot express. */
  check?: (value: unknown, ctx: SaveHookContext) => void;
  /** Runs after the value is stored; `previous` is the value it replaced. */
  after?: (value: unknown, previous: unknown, ctx: SaveHookContext) => void;
}

const SAVE_HOOKS: Partial<Record<GlobalSettingKey, SaveHook>> = {
  // Enabling remediation refreshes existing snapshots without waiting for a PR change.
  "advanced.autoResolveConflicts": {
    after: (value, previous, ctx) => {
      if (value === true && previous !== true) ctx.onAutoResolveConflictsEnabled?.();
    },
  },
  "advanced.autoFixCi": {
    after: (value, previous, ctx) => {
      if (value === true && previous !== true) ctx.onAutoFixCiEnabled?.();
    },
  },
  // docs/303 req 23 — the earlier card reappears at once, marked stale, and the
  // next turn refreshes it.
  "advanced.sessionStatusCard": {
    after: (value, previous, ctx) => {
      if (value === true && previous !== true) ctx.onSessionStatusCardEnabled?.();
      if (value !== previous) ctx.onSessionStatusCardToggled?.(value === true);
    },
  },
  "services.nonTurnModel": {
    check: (value, ctx) => {
      if (value === null) return;
      const selection = value as NonTurnModelSelection;
      // The background-work search, not a harness search: a model provider whose
      // credential permits a direct call needs no installed harness (docs/299
      // req 3), and asking for one here refused by hand what seeding accepts.
      const runnable = runnerForNonTurnSelection(
        selection,
        listConfiguredCredentials(ctx.credentialStore),
      );
      if (!runnable) {
        throw new ServiceError(
          400,
          `Nothing can run ${selection.serviceId}/${selection.billingMode}/${selection.modelId} with the credentials configured — no installed harness carries it, and its credential may not be called directly`,
        );
      }
    },
    after: (value, _previous, ctx) => {
      // Older clients send null; reseed once when a runnable selection exists.
      if (value === null) seedNonTurnModel(ctx.credentialStore, ctx.agentRegistry);
    },
  },
};

/**
 * Two `git config` calls, so the write reports which of them landed rather than
 * returning as if both did (docs/299 → "Saved" has to mean saved). Go through
 * `applyGitIdentity` (`settings-apply.ts`), not this: the lock and the settings
 * broadcast live there.
 */
export function setGitIdentityService(
  name: string,
  email: string,
): { identity: { name: string; email: string }; outcome: ApplyOutcome } {
  const declaration = GLOBAL_SETTINGS["git.identity"];
  const checked = declaration.type.validate({ name, email }, declaration.label);
  if (!checked.ok) throw new ServiceError(400, checked.message);
  return { identity: checked.value, outcome: writeGitIdentity(checked.value.name, checked.value.email) };
}

export interface SaveGlobalSettingsOptions extends GlobalSettingsPatch {
  agentRegistry: AgentRegistry;
  /** Orchestrator workspace containing the global system prompt. */
  appWorkspaceDir: string;
  credentialStore: CredentialStore;
  providerAccountManager?: ProviderAccountManager;
  onAutoResolveConflictsEnabled?: () => void;
  onAutoFixCiEnabled?: () => void;
  onSessionStatusCardEnabled?: () => void;
  onSessionStatusCardToggled?: (enabled: boolean) => void;
  // Addressed per service or per item; not derived from the catalogue yet.
  failoverCutoffs?: Record<string, Partial<FailoverCutoffs>>;
  accountSelectionMode?: Record<string, AccountSelectionMode>;
  reviewers?: Record<string, unknown>;
  roles?: Record<string, unknown>;
}

interface SubscriptionModeTarget { serviceId: string; billingMode: "sub" }

function planFailoverCutoffs(
  cutoffs: Record<string, Partial<FailoverCutoffs>> | undefined,
): { target: SubscriptionModeTarget; patch: Partial<FailoverCutoffs> }[] {
  if (cutoffs === undefined) return [];
  return Object.entries(cutoffs).map(([key, patch]) => {
    const target = requireSubscriptionModeKey(key);
    for (const window of ["session", "weekly"] as const) {
      const value = patch[window];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new ServiceError(400, `${window} failover cutoff must be an integer between 1 and 100`);
      }
    }
    return { target, patch };
  });
}

function planSelectionModes(
  modes: Record<string, AccountSelectionMode> | undefined,
): { target: SubscriptionModeTarget; mode: AccountSelectionMode }[] {
  if (modes === undefined) return [];
  return Object.entries(modes).map(([key, mode]) => {
    const target = requireSubscriptionModeKey(key);
    if (mode !== "strict" && mode !== "balanced") {
      throw new ServiceError(400, `Account selection mode must be "strict" or "balanced"`);
    }
    return { target, mode };
  });
}

// Resolve all slots before writing any, so a bad second slot cannot partly save.
function planReviewerPins(
  reviewers: Record<string, unknown> | undefined,
  credentialStore: CredentialStore,
): [ReviewerSlot, ReviewerPin | null][] {
  if (reviewers === undefined) return [];
  if (reviewers === null || typeof reviewers !== "object" || Array.isArray(reviewers)) {
    throw new ServiceError(400, "reviewers must be an object keyed by reviewer slot");
  }
  return Object.entries(reviewers).map(([slot, raw]) => {
    const patch: ReviewerPinPatch | null = parseReviewerPinPatch(raw, slot);
    return [
      requireReviewerSlot(slot),
      patch === null ? null : resolveReviewerPinPatch(patch, credentialStore),
    ];
  });
}

function requireRolesObject(roles: unknown): Record<string, unknown> {
  if (roles === null || typeof roles !== "object" || Array.isArray(roles)) {
    throw new ServiceError(400, "roles must be an object keyed by role name");
  }
  return roles as Record<string, unknown>;
}

export interface SaveGlobalSettingsResult {
  settings: GlobalSettings;
  /**
   * Whether every part of the save is durable. A save writes to the credential
   * store, the instructions files and the git config, and any of the three can
   * fail on its own — so this is the whole save's answer, not the last write's
   * (docs/299 → "Saved" has to mean saved).
   */
  outcome: ApplyOutcome;
}

/**
 * Go through `applyGlobalSettings` (`settings-apply.ts`) rather than calling
 * this: the conflict-domain lock and the settings broadcast live there, and this
 * function raises neither.
 */
export async function saveGlobalSettings(
  opts: SaveGlobalSettingsOptions,
): Promise<SaveGlobalSettingsResult> {
  const {
    agentRegistry, appWorkspaceDir, credentialStore, providerAccountManager,
    failoverCutoffs, accountSelectionMode, reviewers, roles,
  } = opts;

  const derivationCtx = { appWorkspaceDir, credentialStore };
  const hookCtx: SaveHookContext = {
    agentRegistry,
    credentialStore,
    ...(opts.onAutoResolveConflictsEnabled
      ? { onAutoResolveConflictsEnabled: opts.onAutoResolveConflictsEnabled } : {}),
    ...(opts.onAutoFixCiEnabled ? { onAutoFixCiEnabled: opts.onAutoFixCiEnabled } : {}),
    ...(opts.onSessionStatusCardEnabled
      ? { onSessionStatusCardEnabled: opts.onSessionStatusCardEnabled } : {}),
    ...(opts.onSessionStatusCardToggled
      ? { onSessionStatusCardToggled: opts.onSessionStatusCardToggled } : {}),
  };

  // Everything is validated before anything is written. A save that ends in a
  // 400 must leave nothing behind: on the shipped path a rejected `roles` block
  // could still have persisted an earlier toggle, and enabling auto-fix CI or
  // auto-resolve is not something a failed request may do.
  const declaredWrites = validateDeclaredSettings(opts);
  for (const write of declaredWrites) {
    SAVE_HOOKS[write.declaration.key as GlobalSettingKey]?.check?.(write.value, hookCtx);
  }
  const cutoffWrites = planFailoverCutoffs(failoverCutoffs);
  const selectionWrites = planSelectionModes(accountSelectionMode);
  const reviewerWrites = planReviewerPins(reviewers, credentialStore);
  const roleWrites = roles === undefined ? undefined : requireRolesObject(roles);
  if (roleWrites) planRoleWrites(roleWrites, credentialStore, { credentialStore });

  // Each write reports for itself, and the weakest answer is the save's answer:
  // the credential store, the instructions files and the git config fail
  // independently, so one durable write says nothing about the next.
  const outcomes: ApplyOutcome[] = [];
  for (const write of declaredWrites) {
    const hook = SAVE_HOOKS[write.declaration.key as GlobalSettingKey];
    const previous = hook?.after
      ? currentDeclaredValue(write.declaration, credentialStore)
      : undefined;
    outcomes.push(await writeDeclaredSetting(write, derivationCtx));
    hook?.after?.(write.value, previous, hookCtx);
  }
  // Folded in only when there IS bespoke work: an empty group reports `applied`,
  // and an `applied` standing for no write would make a lone failed scalar read
  // as a partial save.
  const hasBespokeWrites = cutoffWrites.length > 0 || selectionWrites.length > 0
    || reviewerWrites.length > 0 || roleWrites !== undefined;
  if (hasBespokeWrites) {
    outcomes.push(credentialStore.transact(() => {
      for (const { target, patch } of cutoffWrites) {
        credentialStore.setFailoverCutoffs(target.serviceId, target.billingMode, patch);
      }
      for (const { target, mode } of selectionWrites) {
        credentialStore.setSelectionMode(target.serviceId, target.billingMode, mode);
      }
      for (const [slot, pin] of reviewerWrites) credentialStore.setReviewerPin(slot, pin);
      if (roleWrites) {
        // Re-planned here rather than reused from the validation pass above: a role
        // plan carries an existence check, and another save can land in an await
        // between the two. Planning and applying in one synchronous run is what the
        // shipped `applyRoleWrites` gave for free.
        for (const plan of planRoleWrites(roleWrites, credentialStore, { credentialStore })) {
          // Create before deleting the old name so a crash cannot lose both
          // copies — and only delete once the create is DURABLE, because a
          // rolled-back create followed by a successful delete loses the role
          // outright.
          const created = credentialStore.setRole(plan.name, plan.role);
          if (created.status === "applied" && plan.previousName && plan.previousName !== plan.name) {
            credentialStore.setRole(plan.previousName, null);
          }
        }
      }
    }).outcome);
  }

  return {
    settings: await getGlobalSettings(agentRegistry, appWorkspaceDir, credentialStore, providerAccountManager),
    outcome: combineOutcomes(outcomes),
  };
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
      `${info.name} has no models available. Add a credential for a provider it can reach in Settings → Model providers.`,
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
  // The catalogue is the list; a hand-maintained one silently rejects every new
  // harness's sign-in before its auth manager is ever reached.
  if (!allHarnesses().some((h) => h.id === provider)) {
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
