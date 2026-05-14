/**
 * AgentRegistry — runtime detection of installed agent CLIs and auth status.
 *
 * Checks which agent binaries are on $PATH and whether their credentials
 * are configured. Used by the server to expose agent availability to clients
 * and to validate `set_agent` requests.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentId, AgentCapabilities } from "./types/agent-types.js";

const execFileAsync = promisify(execFile);

export interface AgentInfo {
  id: AgentId;
  name: string;
  binary: string;
  installed: boolean;
  authConfigured: boolean;
  capabilities: AgentCapabilities;
}

/** Agent metadata definitions (static). */
const AGENT_DEFS: { id: AgentId; name: string; binary: string; capabilities: AgentCapabilities }[] = [
  {
    id: "claude",
    name: "Claude Code",
    binary: "claude",
    capabilities: {
      supportsResume: true,
      supportsImages: true,
      supportsSystemPrompt: true,
      supportsPermissionModes: true,
      supportedPermissionModes: ["auto", "plan", "normal"],
      toolNames: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      models: ["sonnet", "opus", "haiku"],
      supportsReview: true,
    },
  },
  {
    id: "codex",
    name: "Codex",
    binary: "codex",
    capabilities: {
      supportsResume: true,
      supportsImages: false,
      supportsSystemPrompt: true,
      supportsPermissionModes: false,
      supportedPermissionModes: [],
      toolNames: ["shell", "file_write", "file_read", "file_edit"],
      models: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
      supportsReview: false,
    },
  },
];

/** Env var required for each agent's auth (Claude uses OAuth, not an env var). */
const AUTH_ENV_KEYS: Partial<Record<AgentId, string>> = {
  codex: "OPENAI_API_KEY",
};

/**
 * Literal exact-match allowlist of env var keys that can be set via the
 * `set_agent_env` message. MCP secrets (`mcp__*`) are allowed in addition to
 * these via {@link isAllowedAgentEnvKey} — prefer that predicate over direct
 * `.has()` checks. The set is kept exported because tests and re-export sites
 * still reference it directly.
 */
export const ALLOWED_ENV_KEYS = new Set(["OPENAI_API_KEY"]);

/** Prefix reserved for MCP server secrets (docs/088-mcp-integration). */
const MCP_ENV_KEY_PREFIX = "mcp__";

/**
 * Predicate for agent env keys: true for any literal allowlist entry OR any
 * key in the `mcp__*` namespace. Consumed by `app-di.ts` (loading persisted
 * `CredentialStore.agentEnv` into `process.env` at startup) and
 * `services/settings.ts` (validating `set_agent_env` writes).
 */
export function isAllowedAgentEnvKey(key: string): boolean {
  return ALLOWED_ENV_KEYS.has(key) || key.startsWith(MCP_ENV_KEY_PREFIX);
}

/**
 * Default context window in tokens, used when a model is not in
 * `MODEL_CONTEXT_WINDOWS` or when no model is yet known. Equal to the
 * Claude Sonnet/Opus/Haiku 4.x window, which is the most common case.
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * Per-model context window sizes in tokens. Keys are matched first as exact
 * names, then by substring (so e.g. "claude-sonnet-4-20250514" matches
 * "sonnet"). Models not listed fall back to `DEFAULT_CONTEXT_WINDOW_TOKENS`.
 *
 * Add entries here when a model with a different context window is added to
 * the agent registry. Values come from each provider's published model
 * specifications.
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Claude (200K standard; Opus 4.6 in 1M-mode is opt-in via model alias)
  "sonnet": 200_000,
  "claude-sonnet": 200_000,
  "opus": 200_000,
  "claude-opus": 200_000,
  "haiku": 200_000,
  "claude-haiku": 200_000,
  "opus-1m": 1_000_000,
  // Codex / GPT-5 family (256K)
  "gpt-5": 256_000,
  "gpt-5.4": 256_000,
  "gpt-5.4-mini": 256_000,
  "gpt-5.3-codex": 256_000,
};

/**
 * Resolve a context window size for a model identifier.
 *
 * Match order:
 *   1. Exact key in `MODEL_CONTEXT_WINDOWS`.
 *   2. Substring match against any key (longest key wins, so "gpt-5.4-mini"
 *      beats "gpt-5" when both match).
 *   3. `DEFAULT_CONTEXT_WINDOW_TOKENS` fallback.
 */
export function getContextWindowForModel(model: string | undefined): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW_TOKENS;
  const exact = MODEL_CONTEXT_WINDOWS[model];
  if (exact) return exact;
  let bestKey: string | null = null;
  for (const key of Object.keys(MODEL_CONTEXT_WINDOWS)) {
    if (model.includes(key) && (bestKey === null || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  return bestKey ? MODEL_CONTEXT_WINDOWS[bestKey] : DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export class AgentRegistry {
  private agents = new Map<AgentId, AgentInfo>();

  /**
   * Optional function to check if the binary exists.
   * Defaults to running `which <binary>`. Inject in tests.
   */
  private checkBinary: (binary: string) => Promise<boolean>;

  /**
   * Optional function to check Claude auth status.
   * Inject to wire up AuthManager in production.
   */
  private checkClaudeAuth: () => boolean;

  /**
   * Optional function to check Codex ChatGPT-subscription auth status (i.e.
   * presence of `~/.codex/auth.json` written by `codex login --device-auth`).
   * Defaults to "no file auth", so a Codex agent is considered configured
   * iff `OPENAI_API_KEY` is set in the env. Inject to wire up
   * `CodexAuthManager.checkCredentials()` in production.
   *
   * See docs/119-codex-subscription-auth/plan.md.
   */
  private checkCodexAuth: () => boolean;

  constructor(opts?: {
    checkBinary?: (binary: string) => Promise<boolean>;
    checkClaudeAuth?: () => boolean;
    checkCodexAuth?: () => boolean;
  }) {
    this.checkBinary = opts?.checkBinary ?? defaultCheckBinary;
    this.checkClaudeAuth = opts?.checkClaudeAuth ?? (() => true);
    this.checkCodexAuth = opts?.checkCodexAuth ?? (() => false);
  }

  /** Probe the system for installed agent CLIs. */
  async detect(): Promise<void> {
    for (const def of AGENT_DEFS) {
      const installed = await this.checkBinary(def.binary);
      const authConfigured = this.isAuthConfigured(def.id);
      this.agents.set(def.id, {
        id: def.id,
        name: def.name,
        binary: def.binary,
        installed,
        authConfigured,
        capabilities: def.capabilities,
      });
    }
  }

  /** Get info for a specific agent. */
  get(id: AgentId): AgentInfo | undefined {
    return this.agents.get(id);
  }

  /** List all agents with their availability status. */
  list(): AgentInfo[] {
    return Array.from(this.agents.values());
  }

  /** List only agents that are installed and auth-configured. */
  available(): AgentInfo[] {
    return this.list().filter((a) => a.installed && a.authConfigured);
  }

  /** Re-check auth status for a specific agent. */
  refreshAuth(id: AgentId): void {
    const info = this.agents.get(id);
    if (info) {
      info.authConfigured = this.isAuthConfigured(id);
    }
  }

  private isAuthConfigured(id: AgentId): boolean {
    if (id === "claude") {
      return this.checkClaudeAuth();
    }
    if (id === "codex") {
      // Codex has two auth paths — ChatGPT subscription login (file at
      // ~/.codex/auth.json) OR an OPENAI_API_KEY env var. Either is enough
      // to consider the agent configured. The adapter prefers the file
      // (subscription) when both are present so we don't silently double-
      // bill via Platform API. See docs/119-codex-subscription-auth/plan.md.
      if (this.checkCodexAuth()) return true;
    }
    const envKey = AUTH_ENV_KEYS[id];
    if (!envKey) return false;
    const val = process.env[envKey];
    return typeof val === "string" && val.length > 0;
  }
}

/** Default binary detection using `which`. */
async function defaultCheckBinary(binary: string): Promise<boolean> {
  try {
    await execFileAsync("which", [binary], { stdio: "ignore" } as never);
    return true;
  } catch {
    return false;
  }
}
