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
import { CLAUDE_PERMISSION_MODES } from "./types/agent-types.js";

const execFileAsync = promisify(execFile);

/**
 * Single source of truth for the Claude models offered in the picker.
 *
 * Mixed style is intentional:
 * - Bare family names (`sonnet`, `haiku`) are CLI aliases that always resolve
 *   to the latest of that family on the installed CLI.
 * - Explicit dated/versioned IDs (`claude-opus-4-8`) are listed when a new
 *   model ships before the CLI's alias is bumped to point at it. The CLI
 *   forwards `--model` to the API as-is, so any API-recognized ID works even
 *   if the CLI's local alias table hasn't caught up.
 *
 * No bare `opus` alias: on CLI ≤ 2.1.148 it resolves to Opus 4.7, which we no
 * longer surface. Once Anthropic ships a CLI release where `opus` resolves to
 * Opus 4.8 (or newer), we can re-add the alias and retire the explicit
 * versioned entry the same way.
 *
 * Consumed by both the orchestrator-side `AGENT_DEFS` and the session-side
 * `ClaudeAdapter.capabilities` — keep this the only place to add a model.
 */
export const CLAUDE_MODELS = ["sonnet", "haiku", "claude-opus-4-8"];

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
      supportedPermissionModes: CLAUDE_PERMISSION_MODES,
      toolNames: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      models: CLAUDE_MODELS,
      supportsReview: true,
      supportsSteering: true,
      skillsDirName: ".claude",
      skillInvocationPrefix: "/",
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
      // Verified against the ChatGPT backend's `/backend-api/codex/models`
      // endpoint (ChatGPT Plus plan, codex CLI 0.131.0): these are every
      // model with `visibility: list` and `supported_in_api: true`. Ordering
      // matches the backend listing — gpt-5.5 first (current frontier /
      // default), with the codex-specialized gpt-5.3-codex preserved as its
      // own entry. Update the list when codex publishes new models.
      models: [
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.3-codex",
        "gpt-5.2",
      ],
      // docs/125 — Codex now ships subagents (model-invoked via the
      // `spawn_agent` collab tool, triggered by explicit instruction) AND MCP
      // servers (`[mcp_servers.*]` in config.toml). The worker writes the
      // review bridge into the Codex config; the same chat-native review flow
      // works on both backends.
      supportsReview: true,
      supportsSteering: true,
      skillsDirName: ".codex",
      skillInvocationPrefix: "$",
    },
  },
];

/**
 * Env var required for each agent's auth (Claude uses OAuth, not an env var).
 * Consumers should go through {@link getAuthEnvKey} rather than reading this
 * map directly so a new backend's key (e.g. `CURSOR_API_KEY`) is one edit
 * here, not three across services/settings + index.ts. (docs/155)
 */
const AUTH_ENV_KEYS: Partial<Record<AgentId, string>> = {
  codex: "OPENAI_API_KEY",
};

/**
 * Name of the env var that holds an agent's API key, or `null` for backends
 * that don't use one (Claude — OAuth). The string is the human-facing
 * identifier the UI surfaces ("OPENAI_API_KEY is not set"), so don't change
 * it without also updating the matching settings page copy.
 */
export function getAuthEnvKey(agentId: AgentId): string | null {
  return AUTH_ENV_KEYS[agentId] ?? null;
}

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

// Context-window lookup helpers live in `model-windows.ts` so the client can
// import them without pulling node-only deps from this file. Re-exported here
// to preserve existing server-side import paths.
export {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  MODEL_CONTEXT_WINDOWS,
  getContextWindowForModel,
} from "./model-windows.js";

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
    const envKey = getAuthEnvKey(id);
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
