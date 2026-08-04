/**
 * Settings services — reads (agents, global settings) and mutations
 * (git identity, global settings, agents, API key).
 */

import type { CredentialStore } from "../credential-store.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";
import { getAuthEnvKey, isAllowedAgentEnvKey } from "../../shared/agent-registry.js";
import type { AccountSelectionMode, AgentId, FailoverCutoffs, ProviderAccount, SubAgentDefaultsPatch } from "../../shared/types.js";
import { DEFAULT_FAILOVER_CUTOFF, DEFAULT_SELECTION_MODE } from "../../shared/types.js";
import type { VoiceDeliveryMode } from "../../shared/types/voice-note-types.js";
import { getGitIdentity, setGitIdentity as writeGitIdentity } from "../git-config.js";
import { buildAgentSystemInstructions } from "../agent-instructions.js";
import { readGlobalSystemPrompt, writeGlobalSystemPrompt } from "../global-system-prompt.js";
import { ServiceError } from "./types.js";
import type { AgentInfo, GlobalSettings } from "./types.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import { switchSessionProviderAccount } from "./provider-account-switch.js";
import { revokeSessionProviderCredentials } from "../session-agent-credentials.js";

// ---- Read operations ----

/** Map agent registry entries to the client-facing agent info shape. */
export function listAgents(agentRegistry: AgentRegistry): AgentInfo[] {
  return agentRegistry.list().map((a) => ({
    id: a.id,
    name: a.name,
    installed: a.installed,
    authConfigured: a.authConfigured,
    models: a.capabilities.models,
    supportsReview: a.capabilities.supportsReview,
    supportsSteering: a.capabilities.supportsSteering,
    supportsCompaction: a.capabilities.supportsCompaction,
    supportedPermissionModes: a.capabilities.supportedPermissionModes,
    skillInvocationPrefix: a.capabilities.skillInvocationPrefix,
    ...(a.capabilities.reasoning ? { reasoning: a.capabilities.reasoning } : {}),
  }));
}

/**
 * Get global settings (git identity, system prompt, agents, resource limits).
 *
 * `appWorkspaceDir` is the orchestrator's own workspace root, not a session
 * clone — it is where the GLOBAL system prompt lives (see
 * `global-system-prompt.ts`).
 */
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
  const maxIdleContainers = credentialStore?.getMaxIdleContainers() ?? 5;
  const agentSystemInstructionsEnabled = credentialStore?.getAgentSystemInstructionsEnabled() ?? true;
  const autoCreatePr = credentialStore?.getAutoCreatePr() ?? false;
  const liveSteering = credentialStore?.getLiveSteering() ?? true;
  const autoResolveConflicts = credentialStore?.getAutoResolveConflicts() ?? false;
  const autoFixCi = credentialStore?.getAutoFixCi() ?? false;
  const autoResetMergedBranch = credentialStore?.getAutoResetMergedBranch() ?? true;
  const enableSubAgents = credentialStore?.getEnableSubAgents() ?? false;
  const agentSubAgentDefaults = credentialStore?.getAllAgentSubAgentDefaults() ?? {};
  // Settings page renders the per-agent "Parallel sessions" guidance as a
  // preview. Pick the first installed-and-authed agent so a Codex-only host
  // shows Codex's variant, not Claude's. Fall back to the first registered
  // agent so the preview is never empty.
  const previewAgent = agentRegistry.available()[0] ?? agentRegistry.list()[0];
  const agentSystemInstructions = previewAgent
    ? buildAgentSystemInstructions({ agentId: previewAgent.id })
    : "";
  const providerAccounts = providerAccountManager?.list() ?? credentialStore?.listProviderAccounts() ?? [];
  const voiceDeliveryMode = credentialStore?.getVoiceDeliveryMode() ?? "native";
  const voiceWebhookConfigured = !!credentialStore?.getVoiceWebhook();
  // docs/150 reqs 4-6 — per-provider proactive failover cutoffs, one entry per
  // registered agent so the Settings control can render a row per provider
  // without the client knowing the default.
  const failoverCutoffs: Record<string, FailoverCutoffs> = {};
  // docs/150 req 21 — same shape and the same reason: one entry per registered
  // agent so the client renders the control without knowing the default.
  const accountSelectionMode: Record<string, AccountSelectionMode> = {};
  for (const agent of agentRegistry.list()) {
    failoverCutoffs[agent.id] = credentialStore?.getFailoverCutoffs(agent.id)
      ?? { session: DEFAULT_FAILOVER_CUTOFF, weekly: DEFAULT_FAILOVER_CUTOFF };
    accountSelectionMode[agent.id] = credentialStore?.getSelectionMode(agent.id) ?? DEFAULT_SELECTION_MODE;
  }
  return { failoverCutoffs, accountSelectionMode, gitIdentity, systemPrompt, agents, maxIdleContainers, agentSystemInstructionsEnabled, agentSystemInstructions, autoCreatePr, liveSteering, autoResolveConflicts, autoFixCi, autoResetMergedBranch, enableSubAgents, agentSubAgentDefaults, voiceDeliveryMode, voiceWebhookConfigured, providerAccounts };
}

// ---- Mutation operations ----

/** Set git identity (global git config). */
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

/**
 * Save global settings.
 *
 * docs/146 — the parameter shape is an options object rather than the legacy
 * 11-positional-list. Each per-feature toggle (autoCreatePr, liveSteering,
 * autoResolveConflicts, agentSystemInstructionsEnabled, …) is opt-in: omit
 * the field to leave it unchanged. Adding a new toggle is a single named
 * field instead of "what's the 12th positional argument?".
 */
export interface SaveGlobalSettingsOptions {
  agentRegistry: AgentRegistry;
  /**
   * The orchestrator's own workspace root, not a session clone — the GLOBAL
   * system prompt lives under it (see `global-system-prompt.ts`).
   */
  appWorkspaceDir: string;
  credentialStore: CredentialStore;
  providerAccountManager?: ProviderAccountManager;
  /** docs/146 — fired exactly when `autoResolveConflicts` transitions false → true. */
  onAutoResolveConflictsEnabled?: () => void;
  /** docs/169 — fired exactly when `autoFixCi` transitions false → true. */
  onAutoFixCiEnabled?: () => void;
  gitIdentity?: { name: string; email: string };
  systemPrompt?: string;
  maxIdleContainers?: number;
  agentSystemInstructionsEnabled?: boolean;
  autoCreatePr?: boolean;
  liveSteering?: boolean;
  /**
   * docs/146 — when true, the PR poller's auto-resolve loop fires on
   * CONFLICTING transitions while the agent is idle.
   */
  autoResolveConflicts?: boolean;
  /** docs/169 — when true, the PR poller's auto-fix-CI loop fires on FAILURE while the agent is idle. */
  autoFixCi?: boolean;
  /** docs/218 — when true, resuming a merged, untouched session resets its branch to the latest base before the turn. */
  autoResetMergedBranch?: boolean;
  /** docs/144 — global gate for sub-agent spawning. */
  enableSubAgents?: boolean;
  /**
   * docs/217 — per-agent sub-agent defaults patch, keyed by agent id. Each entry
   * is merged into the stored value; a `null` field clears it. `reasoningEffort`
   * is validated against the agent's registered reasoning options and `model`
   * against its registered models.
   */
  agentSubAgentDefaults?: Record<string, SubAgentDefaultsPatch>;
  /** docs/150 reqs 4-6 — per-provider proactive failover cutoffs (1-100). */
  failoverCutoffs?: Record<string, Partial<FailoverCutoffs>>;
  /** docs/150 req 21 — per-provider account selection mode. */
  accountSelectionMode?: Record<string, AccountSelectionMode>;
  /** docs/163 — voice-note delivery mode (native / external / both). */
  voiceDeliveryMode?: VoiceDeliveryMode;
}

export async function saveGlobalSettings(
  opts: SaveGlobalSettingsOptions,
): Promise<GlobalSettings> {
  const {
    agentRegistry, appWorkspaceDir, credentialStore, providerAccountManager,
    onAutoResolveConflictsEnabled,
    gitIdentity, systemPrompt, maxIdleContainers,
    agentSystemInstructionsEnabled, autoCreatePr, liveSteering,
    autoResolveConflicts, autoFixCi, autoResetMergedBranch, enableSubAgents, agentSubAgentDefaults, voiceDeliveryMode,
    failoverCutoffs, accountSelectionMode,
  } = opts;

  // Save git identity if provided
  if (gitIdentity) {
    const name = typeof gitIdentity.name === "string" ? gitIdentity.name.trim() : "";
    const email = typeof gitIdentity.email === "string" ? gitIdentity.email.trim() : "";
    if (!name) throw new ServiceError(400, "Git user name cannot be empty");
    if (!email) throw new ServiceError(400, "Git email cannot be empty");
    if (name.length > 200) throw new ServiceError(400, "Git user name is too long (max 200 characters)");
    if (email.length > 200) throw new ServiceError(400, "Git email is too long (max 200 characters)");
    writeGitIdentity(name, email);
  }

  // Save system prompt if provided
  if (systemPrompt !== undefined) {
    const content = typeof systemPrompt === "string" ? systemPrompt : "";
    if (content.length > 50_000) throw new ServiceError(400, "System prompt too long (max 50,000 characters)");
    await writeGlobalSystemPrompt(appWorkspaceDir, content);
  }

  // Save max idle containers if provided
  if (maxIdleContainers !== undefined) {
    const n = Math.max(0, Math.floor(maxIdleContainers));
    credentialStore.setMaxIdleContainers(n);
  }

  // Save agent system instructions toggle if provided
  if (agentSystemInstructionsEnabled !== undefined) {
    credentialStore.setAgentSystemInstructionsEnabled(agentSystemInstructionsEnabled);
  }

  // Save auto-create PR toggle if provided
  if (autoCreatePr !== undefined) {
    credentialStore.setAutoCreatePr(autoCreatePr);
  }

  // Save live steering toggle if provided
  if (liveSteering !== undefined) {
    credentialStore.setLiveSteering(liveSteering);
  }

  // docs/144 — save sub-agent spawning gate if provided
  if (enableSubAgents !== undefined) {
    credentialStore.setEnableSubAgents(enableSubAgents);
  }

  // docs/150 reqs 4-6 — validate rather than clamp at the API edge: a request
  // carrying 0 or 150 is a caller bug, and silently accepting it as 1 or 100
  // would hide it. The store still clamps on read, which covers a config file
  // edited by hand.
  if (failoverCutoffs !== undefined) {
    for (const [agentId, patch] of Object.entries(failoverCutoffs)) {
      if (!agentRegistry.get(agentId as AgentId)) throw new ServiceError(400, `Unknown agent: ${agentId}`);
      for (const key of ["session", "weekly"] as const) {
        const value = patch[key];
        if (value === undefined) continue;
        if (!Number.isInteger(value) || value < 1 || value > 100) {
          throw new ServiceError(400, `${key} failover cutoff must be an integer between 1 and 100`);
        }
      }
      credentialStore.setFailoverCutoffs(agentId as AgentId, patch);
    }
  }

  // docs/150 req 21 — validated the same way as the cutoffs above: reject an
  // unknown agent or an unrecognized mode rather than coercing it. The store
  // falls back to the default on *read*, which covers a hand-edited config
  // file; a bad value arriving through the API is a caller bug and should say
  // so.
  if (accountSelectionMode !== undefined) {
    for (const [agentId, mode] of Object.entries(accountSelectionMode)) {
      if (!agentRegistry.get(agentId as AgentId)) throw new ServiceError(400, `Unknown agent: ${agentId}`);
      if (mode !== "strict" && mode !== "balanced") {
        throw new ServiceError(400, `Account selection mode must be "strict" or "balanced"`);
      }
      credentialStore.setSelectionMode(agentId as AgentId, mode);
    }
  }

  // docs/217 — merge per-agent sub-agent defaults. Validate each agent id and
  // each field's value against the registry before persisting; a bad value is a
  // 400 (the picker only ever sends in-set values, so this guards API misuse).
  if (agentSubAgentDefaults !== undefined) {
    for (const [agentId, patch] of Object.entries(agentSubAgentDefaults)) {
      const info = agentRegistry.get(agentId as AgentId);
      if (!info) throw new ServiceError(400, `Unknown agent: ${agentId}`);
      if ("reasoningEffort" in patch) {
        const value = patch.reasoningEffort;
        if (value !== null && value !== undefined) {
          const allowed = info.capabilities.reasoning?.options.some((o) => o.value === value);
          if (!allowed) {
            throw new ServiceError(400, `Invalid reasoning effort "${value}" for ${info.name}`);
          }
        }
        credentialStore.setAgentSubAgentDefaults(agentId, { reasoningEffort: value ?? null });
      }
      if ("model" in patch) {
        const value = patch.model;
        if (value !== null && value !== undefined) {
          if (!info.capabilities.models.includes(value)) {
            throw new ServiceError(400, `Invalid model "${value}" for ${info.name}`);
          }
        }
        credentialStore.setAgentSubAgentDefaults(agentId, { model: value ?? null });
      }
    }
  }

  // docs/163 — save voice-note delivery mode if provided
  if (voiceDeliveryMode !== undefined) {
    credentialStore.setVoiceDeliveryMode(voiceDeliveryMode);
  }

  // docs/146 — save auto-resolve toggle. On a false → true edge, fire the
  // re-broadcast hook so existing tracked sessions get their now-ungated
  // `autoResolve` block onto the next SSE snapshot without waiting for a
  // genuine PR-status change (which can take tens of minutes on a sticky
  // conflict).
  if (autoResolveConflicts !== undefined) {
    const prev = credentialStore.getAutoResolveConflicts();
    credentialStore.setAutoResolveConflicts(autoResolveConflicts);
    if (!prev && autoResolveConflicts) onAutoResolveConflictsEnabled?.();
  }

  // docs/169 — save auto-fix-CI toggle. On a false → true edge, re-broadcast
  // snapshots so existing tracked sessions reflect the now-active loop without
  // waiting for a genuine PR-status change.
  if (autoFixCi !== undefined) {
    const prev = credentialStore.getAutoFixCi();
    credentialStore.setAutoFixCi(autoFixCi);
    if (!prev && autoFixCi) opts.onAutoFixCiEnabled?.();
  }

  // docs/218 — save the auto-reset-merged-branch toggle. No re-broadcast hook:
  // the `reset_eligible` signal is recomputed on each session activation and
  // post-turn, so a flipped setting takes effect the next time the user opens or
  // acts in a merged session (the client ANDs the setting with the signal).
  if (autoResetMergedBranch !== undefined) {
    credentialStore.setAutoResetMergedBranch(autoResetMergedBranch);
  }

  return getGlobalSettings(agentRegistry, appWorkspaceDir, credentialStore, providerAccountManager);
}

/** Validate and set the active agent. Returns the agent ID or throws. */
export function setAgent(
  agentRegistry: AgentRegistry,
  agentId: AgentId,
): { agentId: AgentId } {
  const info = agentRegistry.get(agentId);
  if (!info) throw new ServiceError(400, `Unknown agent: ${agentId}`);
  if (!info.installed) throw new ServiceError(400, `${info.name} CLI is not installed in this environment`);
  if (!info.authConfigured) {
    const envKey = getAuthEnvKey(agentId);
    throw new ServiceError(400, `${envKey ?? "API key"} is not set. Add it in Settings → Agents.`);
  }
  return { agentId };
}

/** Set an agent environment variable. */
export function setAgentEnv(
  agentRegistry: AgentRegistry,
  credentialStore: CredentialStore,
  agentId: AgentId,
  key: string,
  value: string,
): { agentId: AgentId; key: string; agents: AgentInfo[] } {
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
  credentialStore.setAgentEnv(key, value);
  agentRegistry.refreshAuth(agentId);
  return { agentId, key, agents: listAgents(agentRegistry) };
}

// docs/150 req 19 — `startAuth` / `submitAuthCode` are gone with the singleton
// endpoints that were their only callers. The account-scoped equivalents live
// in `provider-accounts.ts` (`startProviderAccountLogin`,
// `submitProviderAccountCode`), which take the account whose credentials the
// flow will write.

/** Set API key. Returns true if valid. */
export function setApiKey(
  key: string,
): void {
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (!trimmed) throw new ServiceError(400, "API key cannot be empty");
  if (!trimmed.startsWith("sk-ant-")) throw new ServiceError(400, "Invalid API key format");
  process.env.ANTHROPIC_API_KEY = trimmed;
}

/** Clear API key. Returns whether still authenticated. */
export function clearApiKey(): void {
  delete process.env.ANTHROPIC_API_KEY;
}

// ---- Provider account management (docs/150) ----

export function listProviderAccounts(providerAccountManager: ProviderAccountManager): { accounts: ProviderAccount[] } {
  return { accounts: providerAccountManager.list() };
}

export function createProviderAccount(
  providerAccountManager: ProviderAccountManager,
  provider: AgentId,
  label?: string,
): { account: ProviderAccount; accounts: ProviderAccount[] } {
  validateProvider(provider);
  const account = providerAccountManager.create(provider, label);
  return { account, accounts: providerAccountManager.list() };
}

export function renameProviderAccount(
  providerAccountManager: ProviderAccountManager,
  provider: AgentId,
  accountId: string,
  label: string,
): { account: ProviderAccount; accounts: ProviderAccount[] } {
  validateProvider(provider);
  validateAccountId(accountId);
  try {
    const account = providerAccountManager.rename(provider, accountId, label);
    return { account, accounts: providerAccountManager.list() };
  } catch (err) {
    throw providerAccountServiceError(err);
  }
}

export function makePrimaryProviderAccount(
  providerAccountManager: ProviderAccountManager,
  provider: AgentId,
  accountId: string,
): { account: ProviderAccount; accounts: ProviderAccount[] } {
  validateProvider(provider);
  validateAccountId(accountId);
  try {
    const account = providerAccountManager.makePrimary(provider, accountId);
    return { account, accounts: providerAccountManager.list() };
  } catch (err) {
    throw providerAccountServiceError(err);
  }
}

/**
 * docs/150 req 2 — persist the user's fallback order for a provider.
 *
 * `accountIds` must be the complete set: a partial list is rejected rather than
 * interpreted, so a stale client (one whose account list predates an account
 * added in another tab) gets a 400 instead of silently demoting that account to
 * the end of the order.
 */
export function reorderProviderAccounts(
  providerAccountManager: ProviderAccountManager,
  provider: AgentId,
  accountIds: unknown,
): { accounts: ProviderAccount[] } {
  validateProvider(provider);
  if (!Array.isArray(accountIds) || accountIds.some((id) => typeof id !== "string" || !id)) {
    throw new ServiceError(400, "accountIds must be an array of account ids");
  }
  for (const id of accountIds as string[]) validateAccountId(id);
  try {
    providerAccountManager.reorder(provider, accountIds as string[]);
    return { accounts: providerAccountManager.list() };
  } catch (err) {
    throw providerAccountServiceError(err);
  }
}

/**
 * Disconnect a provider account (docs/150).
 *
 * Sessions pinned to the account are the hard part. Deleting the credentials
 * out from under them would leave the user with sessions that cannot take
 * another turn, so this used to refuse outright ("until account switching is
 * available"). Account switching now exists, so the refusal becomes a choice:
 * pass `replacementAccountId` and the pinned sessions move there first,
 * conversation intact (req 9). Without one — but with somewhere to move them —
 * the caller gets a 409 that lists the candidates, which is a question with an
 * answer rather than a dead end.
 *
 * With **nowhere** to move them it is not a question at all, so it no longer
 * refuses (req 23). That branch used to 409 with "there is no other connected
 * account to move them to", which is terminal by construction: the last
 * connected account for a provider could never be disconnected while any
 * unarchived session was pinned to it, and connecting a second account just to
 * disconnect the first is not a workflow.
 *
 * Those sessions have to actually *lose* the account, which takes more than
 * deleting the row. Each one holds its own copy of the OAuth token in its
 * per-session credentials dir, and that copy is what the CLI reads: first-turn
 * provisioning is guarded on `agentPinned` so it never re-runs, and the only
 * thing that overwrites it is a switch to another account — which is exactly
 * the path not taken here. So this walks the same two steps
 * `switchSessionProviderAccount` takes before it rewrites credentials: retire
 * any resident agent process (it holds the token in memory, where no on-disk
 * change can reach it) and remove the session's credential subtree, preserving
 * the conversation-state files so a later reconnect resumes rather than
 * restarts.
 *
 * The now-dangling `provider_route_id` is left in place on purpose. It reads
 * unusable (`isRouteUsableForTurn`), which is what makes `failoverPinnedSession`
 * re-route the session — and re-provision its credentials — the moment another
 * account is connected. Clearing it would look tidier and would break that
 * recovery: env prep only provisions credentials for a session that is not yet
 * pinned. Until then the session simply has no credentials to run on, which is
 * the honest state and the one req 23 asks for.
 *
 * They come back in `strandedSessionIds` so the caller can say how many.
 *
 * A *running* session is still refused (the user chose this over disconnecting
 * through a live turn, 2026-08-03). Reprovisioning credentials under a live
 * agent is the one case the switch itself declines, and silently killing
 * someone's in-flight turn to satisfy a Settings click is not a trade this
 * should make on their behalf. Unlike the refusal above, waiting clears it — so
 * the message names the sessions to wait for.
 */
/**
 * docs/150 — provider-wide sign-out drops *every* account row for a provider,
 * so it needs the same running-turn guard the per-account disconnect has.
 *
 * Only the running-turn half: a signed-out provider legitimately leaves its
 * pinned sessions without an account, and they recover on their own — a route
 * whose row is gone reads as unusable (`isRouteUsableForTurn`), so the next
 * turn's preflight fails the session over to another account, or reports
 * `auth_required` when the user really did sign out of everything. What does
 * NOT recover is a turn that is running right now: sign-out rewrites the
 * credentials under a live agent, and the user gets a mid-turn 401 instead of
 * an answer.
 */
export function assertNoRunningPinnedSessions(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  provider: AgentId,
): void {
  const running = sessionManager
    .listAll()
    .filter((session) =>
      session.agentId === provider &&
      !session.archived &&
      session.providerRouteKind === "account" &&
      runnerRegistry.get(session.id)?.running,
    );
  if (running.length > 0) {
    throw new ServiceError(
      409,
      `Cannot sign out of ${provider} while ${running.length} session(s) are mid-turn on a connected account.`,
    );
  }
}

/**
 * Take a provider account away from one session that is pinned to it, in the
 * order that matters: **in memory first, then on disk**. The reverse leaves a
 * live CLI spending the account it was just cut off from.
 *
 * Shared by the two entry points that leave a session without the account it
 * was running on — the per-account disconnect (docs/150 req 23) and the
 * provider-wide sign-out (SHI-283). Deleting the account row is not enough on
 * its own: the session holds its *own* copy of the OAuth token, and that copy is
 * what the CLI in the container reads.
 *
 * `context` names the account for the no-`credentialsDir` warning, which is the
 * one case where the copy survives (a caller that has no credentials root to
 * revoke from — only reachable in tests and legacy wiring).
 */
function retireSessionProviderAccount(
  runnerRegistry: SessionRunnerRegistry,
  sessionId: string,
  provider: AgentId,
  credentialsDir: string | undefined,
  context: string,
): void {
  const runner = runnerRegistry.get(sessionId);
  const agent = runner?.getAgent() ?? null;
  if (agent) {
    try {
      agent.kill();
    } catch {
      // Already dead is the state we wanted; the revoke below is what matters
      // and must not be skipped because a stale handle threw.
    }
    runner?.setAgent(null);
  }
  if (credentialsDir) {
    revokeSessionProviderCredentials(credentialsDir, sessionId, provider);
  } else {
    console.warn(
      `[provider-accounts] no credentialsDir: session ${sessionId} keeps its copy of ${context}`,
    );
  }
}

/**
 * SHI-283 — sign out of a provider entirely: every connected account's row and
 * source credentials, **plus** every pinned session's own copy of the token.
 *
 * `ProviderAccountManager.signOutProvider` deletes the account rows and the
 * source subtrees under `provider-accounts/<provider>/<accountId>/`. It never
 * reaches `<credentialsDir>/sessions/<sessionId>/.claude|.codex`, which is the
 * copy the CLI inside the container actually reads — and nothing else removes
 * it either: first-turn provisioning is guarded on `agentPinned` so it never
 * re-runs, and the only writer that replaces the copy is a switch to *another*
 * account, which sign-out does not perform. So "sign out of Claude" removed the
 * accounts from the UI while every session pinned to one kept a working
 * subscription token on disk, free to go on spending that subscription.
 *
 * Same two steps the disconnect path takes, for the same reasons
 * ({@link retireSessionProviderAccount}), scoped deliberately:
 *
 *   - **Only account-route sessions on an account being signed out.** A session
 *     on a reserved route (`claude-env-oauth`) has no account row and its
 *     credentials came from env OAuth, not from anything this deletes; revoking
 *     there would break a path that does not depend on the signed-out accounts.
 *     A dangling pin to an account that is already gone is likewise left alone —
 *     there is no account here to take away from it.
 *   - **Archived sessions included.** They cannot be running, but their
 *     credential subtree survives archival and comes back with them, so leaving
 *     the copy in place is the same leak on a delay.
 *
 * The dangling `provider_route_id` is left in place on purpose, exactly as the
 * disconnect path leaves it: it reads unusable (`isRouteUsableForTurn`), which
 * is what makes the next turn's preflight fail the session over — and
 * re-provision its credentials — once an account is connected again. Clearing it
 * would break that recovery, since env prep only provisions for a session that
 * is not yet pinned.
 *
 * The running-turn guard runs here rather than at the call site so the invariant
 * travels with the operation: nothing rewrites credentials under a live agent.
 * Callers still do their own provider-specific teardown (clearing the stored API
 * key, cancelling an in-flight device flow) *after* this returns, so a 409
 * refusal leaves all of it untouched.
 */
export function signOutProvider(
  providerAccountManager: ProviderAccountManager,
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  provider: AgentId,
  opts: { credentialsDir?: string } = {},
): void {
  validateProvider(provider);
  assertNoRunningPinnedSessions(sessionManager, runnerRegistry, provider);

  const signedOut = new Set(providerAccountManager.list(provider).map((account) => account.id));
  const pinned = sessionManager
    .listAll()
    .filter((session) =>
      session.agentId === provider &&
      session.providerRouteKind === "account" &&
      !!session.providerRouteId &&
      signedOut.has(session.providerRouteId),
    );
  for (const session of pinned) {
    retireSessionProviderAccount(
      runnerRegistry,
      session.id,
      provider,
      opts.credentialsDir,
      `signed-out ${provider} account ${session.providerRouteId}`,
    );
  }

  providerAccountManager.signOutProvider(provider);
}

export function deleteProviderAccount(
  providerAccountManager: ProviderAccountManager,
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  provider: AgentId,
  accountId: string,
  opts: { credentialsDir?: string; replacementAccountId?: string } = {},
): { accounts: ProviderAccount[]; switchedSessionIds: string[]; strandedSessionIds: string[] } {
  validateProvider(provider);
  validateAccountId(accountId);
  const pinned = sessionManager
    .listAll()
    .filter((session) =>
      session.providerRouteKind === "account" &&
      session.providerRouteId === accountId &&
      session.agentId === provider &&
      !session.archived,
    );
  const running = pinned.filter((session) => runnerRegistry.get(session.id)?.running);
  if (running.length > 0) {
    // Name them: this refusal is a wait, and the user can only wait for
    // something they can identify. Cap the list so a mass-running install gets
    // a message rather than a paragraph.
    const named = running.slice(0, 3).map((session) => `"${session.title || session.id}"`).join(", ");
    const rest = running.length - Math.min(running.length, 3);
    throw new ServiceError(
      409,
      `Cannot disconnect an account while a pinned session is running: ${named}${rest > 0 ? ` and ${rest} more` : ""}. `
        + "Let the turn finish or stop it, then disconnect.",
    );
  }

  const switchedSessionIds: string[] = [];
  let strandedSessionIds: string[] = [];
  if (pinned.length > 0) {
    const { replacementAccountId, credentialsDir } = opts;
    const usable = providerAccountManager
      .list(provider)
      .filter((account) => account.id !== accountId && account.status === "ready")
      .map((account) => account.id);
    if (!replacementAccountId || !credentialsDir) {
      // req 23 — only ask when the question has an answer. With no usable
      // account to move to, disconnecting is the user's call and the pinned
      // sessions simply come back without one.
      if (usable.length > 0) {
        throw new ServiceError(
          409,
          `${pinned.length} session(s) are pinned to this account. Choose a replacement account to move them to (available: ${usable.join(", ")}).`,
        );
      }
      for (const session of pinned) {
        retireSessionProviderAccount(
          runnerRegistry,
          session.id,
          provider,
          credentialsDir,
          `disconnected ${provider} account ${accountId}`,
        );
      }
      strandedSessionIds = pinned.map((session) => session.id);
    } else {
      if (replacementAccountId === accountId) {
        throw new ServiceError(400, "Replacement account must differ from the account being disconnected");
      }
      for (const session of pinned) {
        switchSessionProviderAccount(session.id, replacementAccountId, {
          sessionManager,
          runnerRegistry,
          providerAccountManager,
          credentialsDir,
        });
        switchedSessionIds.push(session.id);
      }
    }
  }

  try {
    providerAccountManager.delete(provider, accountId);
    return { accounts: providerAccountManager.list(), switchedSessionIds, strandedSessionIds };
  } catch (err) {
    throw providerAccountServiceError(err);
  }
}

/**
 * Start an account-scoped provider login (docs/150). The provider CLI is
 * spawned with HOME pointed at the account's credential root; pending URL/code
 * and completion stream over the existing `agent_auth_*` SSE family, now
 * carrying the `accountId`. Returns the refreshed account list so the row's
 * `authenticating` status renders immediately.
 */
export function startProviderAccountLogin(
  providerAccountManager: ProviderAccountManager,
  provider: AgentId,
  accountId: string,
): { account: ProviderAccount; accounts: ProviderAccount[] } {
  validateProvider(provider);
  validateAccountId(accountId);
  try {
    const account = providerAccountManager.startAccountAuth(provider, accountId);
    return { account, accounts: providerAccountManager.list() };
  } catch (err) {
    throw providerAccountServiceError(err);
  }
}

/** Cancel an in-flight account-scoped login (docs/150). */
export function cancelProviderAccountLogin(
  providerAccountManager: ProviderAccountManager,
  provider: AgentId,
  accountId: string,
): { account: ProviderAccount; accounts: ProviderAccount[] } {
  validateProvider(provider);
  validateAccountId(accountId);
  try {
    const account = providerAccountManager.cancelAccountAuth(provider, accountId);
    return { account, accounts: providerAccountManager.list() };
  } catch (err) {
    throw providerAccountServiceError(err);
  }
}

/** Submit an OAuth code into an in-flight scoped Claude login (docs/150). */
export function submitProviderAccountCode(
  providerAccountManager: ProviderAccountManager,
  provider: AgentId,
  accountId: string,
  code: string,
): void {
  validateProvider(provider);
  validateAccountId(accountId);
  const trimmed = typeof code === "string" ? code.trim() : "";
  if (!trimmed) throw new ServiceError(400, "Authorization code cannot be empty");
  try {
    providerAccountManager.submitAccountCode(provider, accountId, trimmed);
  } catch (err) {
    throw providerAccountServiceError(err);
  }
}

function validateProvider(provider: AgentId): void {
  if (provider !== "claude" && provider !== "codex") {
    throw new ServiceError(400, "Unknown provider");
  }
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
  // docs/150 — one CLI process per provider, so a sign-in started on another
  // account blocks this one. That's a conflict the user resolves (finish or
  // cancel the other row), not a server fault.
  if (/already signing in|no longer running/i.test(message)) return new ServiceError(409, message);
  return new ServiceError(500, message);
}
