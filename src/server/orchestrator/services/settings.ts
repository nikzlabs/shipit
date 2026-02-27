/**
 * Settings services — reads (agents, global settings) and mutations
 * (git identity, global settings, agents, API key).
 */

import path from "node:path";
import fs from "node:fs/promises";
import type { CredentialStore } from "../credential-store.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";
import { ALLOWED_ENV_KEYS } from "../../shared/agent-registry.js";
import type { AgentId } from "../../shared/types.js";
import { getGitIdentity, setGitIdentity as writeGitIdentity } from "../git-config.js";
import { ServiceError } from "./types.js";
import type { AgentInfo, GlobalSettings } from "./types.js";

// ---- Read operations ----

/** Map agent registry entries to the client-facing agent info shape. */
export function listAgents(agentRegistry: AgentRegistry): AgentInfo[] {
  return agentRegistry.list().map((a) => ({
    id: a.id,
    name: a.name,
    installed: a.installed,
    authConfigured: a.authConfigured,
    models: a.capabilities.models,
  }));
}

/** Get global settings (git identity, system prompt, agents). */
export async function getGlobalSettings(
  agentRegistry: AgentRegistry,
  defaultAgentId: AgentId,
  workspaceDir: string,
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
  return { gitIdentity, systemPrompt, agents, defaultAgentId };
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

/** Save global settings (git identity and/or system prompt). */
export async function saveGlobalSettings(
  agentRegistry: AgentRegistry,
  defaultAgentId: AgentId,
  workspaceDir: string,
  gitIdentity?: { name: string; email: string },
  systemPrompt?: string,
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
      await fs.writeFile(filePath, trimmed + "\n", "utf-8");
    } else {
      try { await fs.unlink(filePath); } catch { /* ok if missing */ }
    }
  }

  return getGlobalSettings(agentRegistry, defaultAgentId, workspaceDir);
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
    const envKey = agentId === "codex" ? "OPENAI_API_KEY" : "";
    throw new ServiceError(400, `${envKey || "API key"} is not set. Add it in Settings → Agents.`);
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
  if (!ALLOWED_ENV_KEYS.has(key)) {
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
