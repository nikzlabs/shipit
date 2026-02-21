import path from "node:path";
import fs from "node:fs/promises";
import type { WsClientMessage } from "../types.js";
import type { HandlerContext } from "./types.js";
import { getErrorMessage } from "../validation.js";
import { ALLOWED_ENV_KEYS } from "../agents/agent-registry.js";

type WsSetApiKey = Extract<WsClientMessage, { type: "set_api_key" }>;
type WsPasteAuthCode = Extract<WsClientMessage, { type: "paste_auth_code" }>;
type WsSetGitIdentity = Extract<WsClientMessage, { type: "set_git_identity" }>;
type WsSaveGlobalSettings = Extract<WsClientMessage, { type: "save_global_settings" }>;
type WsSetAgent = Extract<WsClientMessage, { type: "set_agent" }>;
type WsSetAgentEnv = Extract<WsClientMessage, { type: "set_agent_env" }>;

export function handleSetApiKey(ctx: HandlerContext, msg: WsSetApiKey): void {
  const key = typeof msg.key === "string" ? msg.key.trim() : "";
  if (!key) {
    ctx.send({ type: "error", message: "API key cannot be empty" });
  } else if (!key.startsWith("sk-ant-")) {
    ctx.send({ type: "error", message: "Invalid API key format" });
  } else {
    process.env.ANTHROPIC_API_KEY = key;
    ctx.authManager.kill(); // Stop any pending OAuth flow
    ctx.authManager.checkCredentials(); // Re-check — will now see the API key
    ctx.broadcast({ type: "auth_complete" });
  }
}

export function handleClearApiKey(ctx: HandlerContext): void {
  delete process.env.ANTHROPIC_API_KEY;
  const stillAuthenticated = ctx.authManager.checkCredentials();
  if (!stillAuthenticated) {
    ctx.authManager.startOAuthFlow();
  }
}

export function handleStartAuth(ctx: HandlerContext): void {
  ctx.authManager.startOAuthFlow();
}

export function handlePasteAuthCode(ctx: HandlerContext, msg: WsPasteAuthCode): void {
  const code = typeof msg.code === "string" ? msg.code.trim() : "";
  if (!code) {
    ctx.send({ type: "error", message: "Authorization code cannot be empty" });
  } else {
    ctx.authManager.sendCode(code);
  }
}

export async function handleSetGitIdentity(ctx: HandlerContext, msg: WsSetGitIdentity): Promise<void> {
  const name = typeof msg.name === "string" ? msg.name.trim() : "";
  const email = typeof msg.email === "string" ? msg.email.trim() : "";
  if (!name) {
    ctx.send({ type: "error", message: "Git user name cannot be empty" });
  } else if (!email) {
    ctx.send({ type: "error", message: "Git email cannot be empty" });
  } else if (name.length > 200) {
    ctx.send({ type: "error", message: "Git user name is too long (max 200 characters)" });
  } else if (email.length > 200) {
    ctx.send({ type: "error", message: "Git email is too long (max 200 characters)" });
  } else {
    try {
      const git = ctx.getActiveGitManager();
      await git.setIdentity(name, email);
      // Persist globally so future sessions auto-apply this identity
      ctx.credentialStore.setGitIdentity(name, email);
      ctx.send({ type: "git_identity_set", name, email });
    } catch (err) {
      ctx.send({ type: "error", message: `Failed to set git identity: ${getErrorMessage(err)}` });
    }
  }
}

export async function handleGetGlobalSettings(ctx: HandlerContext): Promise<void> {
  const stored = ctx.credentialStore.getGitIdentity();
  const gitIdentity = stored ? { name: stored.name, email: stored.email } : { name: "", email: "" };
  let systemPrompt = "";
  try {
    systemPrompt = (await fs.readFile(path.join(ctx.workspaceDir, ".shipit", "system-prompt.md"), "utf-8")).trim();
  } catch { /* no file */ }
  const agents = ctx.agentRegistry.list().map((a) => ({
    id: a.id, name: a.name, installed: a.installed,
    authConfigured: a.authConfigured, models: a.capabilities.models,
  }));
  ctx.send({ type: "global_settings", gitIdentity, systemPrompt, agents, defaultAgentId: ctx.defaultAgentId });
}

export async function handleSaveGlobalSettings(ctx: HandlerContext, msg: WsSaveGlobalSettings): Promise<void> {
  // Save git identity if provided
  if (msg.gitIdentity) {
    const name = typeof msg.gitIdentity.name === "string" ? msg.gitIdentity.name.trim() : "";
    const email = typeof msg.gitIdentity.email === "string" ? msg.gitIdentity.email.trim() : "";
    if (!name) {
      ctx.send({ type: "error", message: "Git user name cannot be empty" });
      return;
    } else if (!email) {
      ctx.send({ type: "error", message: "Git email cannot be empty" });
      return;
    } else if (name.length > 200) {
      ctx.send({ type: "error", message: "Git user name is too long (max 200 characters)" });
      return;
    } else if (email.length > 200) {
      ctx.send({ type: "error", message: "Git email is too long (max 200 characters)" });
      return;
    }
    ctx.credentialStore.setGitIdentity(name, email);
  }

  // Save system prompt if provided
  if (msg.systemPrompt !== undefined) {
    const content = typeof msg.systemPrompt === "string" ? msg.systemPrompt : "";
    if (content.length > 50_000) {
      ctx.send({ type: "error", message: "System prompt too long (max 50,000 characters)" });
      return;
    }
    const dir = path.join(ctx.workspaceDir, ".shipit");
    const filePath = path.join(dir, "system-prompt.md");
    const trimmed = content.trim();
    if (trimmed) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, trimmed + "\n", "utf-8");
    } else {
      try { await fs.unlink(filePath); } catch { /* ok if missing */ }
    }
  }

  // Respond with full global settings
  const stored = ctx.credentialStore.getGitIdentity();
  const gitIdentity = stored ? { name: stored.name, email: stored.email } : { name: "", email: "" };
  let systemPrompt = "";
  try {
    systemPrompt = (await fs.readFile(path.join(ctx.workspaceDir, ".shipit", "system-prompt.md"), "utf-8")).trim();
  } catch { /* no file */ }
  const agents = ctx.agentRegistry.list().map((a) => ({
    id: a.id, name: a.name, installed: a.installed,
    authConfigured: a.authConfigured, models: a.capabilities.models,
  }));
  ctx.send({ type: "global_settings", gitIdentity, systemPrompt, agents, defaultAgentId: ctx.defaultAgentId });
}

export function handleSetAgent(ctx: HandlerContext, msg: WsSetAgent): { newAgentId: string } | null {
  const info = ctx.agentRegistry.get(msg.agentId);
  if (!info) {
    ctx.send({ type: "error", message: `Unknown agent: ${msg.agentId}` });
    return null;
  }
  if (!info.installed) {
    ctx.send({ type: "error", message: `${info.name} CLI is not installed in this environment` });
    return null;
  }
  if (!info.authConfigured) {
    const envKey = msg.agentId === "codex" ? "OPENAI_API_KEY" : "";
    ctx.send({ type: "error", message: `${envKey || "API key"} is not set. Add it in Settings \u2192 Agents.` });
    return null;
  }
  return { newAgentId: msg.agentId };
}

export function handleSetAgentEnv(ctx: HandlerContext, msg: WsSetAgentEnv): void {
  if (!msg.agentId || !msg.key || typeof msg.value !== "string") {
    ctx.send({ type: "error", message: "Invalid set_agent_env request" });
    return;
  }
  if (!ALLOWED_ENV_KEYS.has(msg.key)) {
    ctx.send({ type: "error", message: `Environment variable ${msg.key} is not in the allowlist` });
    return;
  }
  if (msg.value.trim().length === 0) {
    ctx.send({ type: "error", message: "Value cannot be empty" });
    return;
  }
  process.env[msg.key] = msg.value;
  ctx.credentialStore.setAgentEnv(msg.key, msg.value);
  ctx.agentRegistry.refreshAuth(msg.agentId);
  ctx.send({ type: "agent_env_set", agentId: msg.agentId, key: msg.key, success: true });
  // Send updated agent list so client can refresh UI
  const agents = ctx.agentRegistry.list().map((a) => ({
    id: a.id,
    name: a.name,
    installed: a.installed,
    authConfigured: a.authConfigured,
    models: a.capabilities.models,
  }));
  ctx.send({ type: "agent_list", agents, defaultAgentId: ctx.defaultAgentId });
}

