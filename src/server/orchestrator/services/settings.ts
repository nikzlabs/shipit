/**
 * Settings services — reads (agents, global settings) and mutations
 * (git identity, global settings, agents, API key).
 */

import path from "node:path";
import fs from "node:fs/promises";
import type { CredentialStore } from "../credential-store.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";
import { getAuthEnvKey, isAllowedAgentEnvKey } from "../../shared/agent-registry.js";
import type { AgentId, ProviderAccount } from "../../shared/types.js";
import { getGitIdentity, setGitIdentity as writeGitIdentity } from "../git-config.js";
import { buildAgentSystemInstructions } from "../agent-instructions.js";
import { ServiceError } from "./types.js";
import type { AgentInfo, GlobalSettings } from "./types.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";

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
    supportedPermissionModes: a.capabilities.supportedPermissionModes,
    skillInvocationPrefix: a.capabilities.skillInvocationPrefix,
  }));
}

/** Get global settings (git identity, system prompt, agents, resource limits). */
export async function getGlobalSettings(
  agentRegistry: AgentRegistry,
  workspaceDir: string,
  credentialStore?: CredentialStore,
  providerAccountManager?: ProviderAccountManager,
): Promise<GlobalSettings> {
  const stored = getGitIdentity();
  const gitIdentity = stored
    ? { name: stored.name, email: stored.email }
    : { name: "", email: "" };

  let systemPrompt = "";
  try {
    systemPrompt = (
      await fs.readFile(
        path.join(workspaceDir, ".shipit", "system-prompt.md"),
        "utf-8",
      )
    ).trim();
  } catch {
    /* no file */
  }

  const agents = listAgents(agentRegistry);
  const maxIdleContainers = credentialStore?.getMaxIdleContainers() ?? 5;
  const agentSystemInstructionsEnabled = credentialStore?.getAgentSystemInstructionsEnabled() ?? true;
  const autoCreatePr = credentialStore?.getAutoCreatePr() ?? false;
  const liveSteering = credentialStore?.getLiveSteering() ?? false;
  // Settings page renders the per-agent "Parallel sessions" guidance as a
  // preview. Pick the first installed-and-authed agent so a Codex-only host
  // shows Codex's variant, not Claude's. Fall back to the first registered
  // agent so the preview is never empty.
  const previewAgent = agentRegistry.available()[0] ?? agentRegistry.list()[0];
  const agentSystemInstructions = previewAgent
    ? buildAgentSystemInstructions({ agentId: previewAgent.id })
    : "";
  const providerAccounts = providerAccountManager?.list() ?? credentialStore?.listProviderAccounts() ?? [];
  return { gitIdentity, systemPrompt, agents, maxIdleContainers, agentSystemInstructionsEnabled, agentSystemInstructions, autoCreatePr, liveSteering, providerAccounts };
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

/** Save global settings (git identity, system prompt, and/or maxIdleContainers). */
export async function saveGlobalSettings(
  agentRegistry: AgentRegistry,
  workspaceDir: string,
  credentialStore: CredentialStore,
  gitIdentity?: { name: string; email: string },
  systemPrompt?: string,
  maxIdleContainers?: number,
  agentSystemInstructionsEnabled?: boolean,
  autoCreatePr?: boolean,
  liveSteering?: boolean,
  providerAccountManager?: ProviderAccountManager,
): Promise<GlobalSettings> {
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
    const dir = path.join(workspaceDir, ".shipit");
    const filePath = path.join(dir, "system-prompt.md");
    const trimmed = content.trim();
    if (trimmed) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, `${trimmed  }\n`, "utf-8");
    } else {
      try { await fs.unlink(filePath); } catch { /* ok if missing */ }
    }
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

  return getGlobalSettings(agentRegistry, workspaceDir, credentialStore, providerAccountManager);
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

/** Start the OAuth flow for Claude CLI authentication. */
export function startAuth(
  authManager: { startOAuthFlow: () => void },
): void {
  authManager.startOAuthFlow();
}

/** Submit an OAuth authorization code. */
export function submitAuthCode(
  authManager: { sendCode: (code: string) => void },
  code: string,
): void {
  const trimmed = typeof code === "string" ? code.trim() : "";
  if (!trimmed) throw new ServiceError(400, "Authorization code cannot be empty");
  authManager.sendCode(trimmed);
}

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

export function deleteProviderAccount(
  providerAccountManager: ProviderAccountManager,
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  provider: AgentId,
  accountId: string,
): { accounts: ProviderAccount[] } {
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
    throw new ServiceError(409, "Cannot disconnect an account while a pinned session is running");
  }
  if (pinned.length > 0) {
    throw new ServiceError(409, "Cannot disconnect an account pinned to existing sessions until account switching is available");
  }
  try {
    providerAccountManager.delete(provider, accountId);
    return { accounts: providerAccountManager.list() };
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
  return new ServiceError(500, message);
}
