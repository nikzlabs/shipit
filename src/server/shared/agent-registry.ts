/**
 * AgentRegistry — runtime detection of installed agent CLIs and auth status.
 *
 * Checks which agent binaries are on $PATH and whether their credentials
 * are configured. Used by the server to expose agent availability to clients
 * and to validate `set_agent` requests.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import type { AgentId, AgentCapabilities } from "./types/agent-types.js";
import { CLAUDE_PERMISSION_MODES } from "./types/agent-types.js";

const execFileAsync = promisify(execFile);

/**
 * Single source of truth for the Claude models offered in the picker.
 *
 * Order matters: `models[0]` is the default model a fresh install runs with.
 * Every default path — the server's connect-time fallback in `index.ts`
 * (`agentInfo?.capabilities.models[0]`) and the client picker's fallback in
 * `ModelAgentSelector` (`activeAgent?.models[0]`, used when there's no
 * persisted session model and no saved `vibe-model-id`) — resolves to the
 * first entry. Opus leads so a brand-new user gets Opus, not Sonnet.
 *
 * Mixed style is intentional:
 * - Explicit dated/versioned IDs (`claude-opus-4-8`) are listed when a new
 *   model ships before the CLI's alias is bumped to point at it. The CLI
 *   forwards `--model` to the API as-is, so any API-recognized ID works even
 *   if the CLI's local alias table hasn't caught up.
 * - Bare family names (`sonnet`, `haiku`) are CLI aliases that always resolve
 *   to the latest of that family on the installed CLI.
 *
 * No bare `opus` alias: on CLI ≤ 2.1.148 it resolves to Opus 4.7, which we no
 * longer surface. Once Anthropic ships a CLI release where `opus` resolves to
 * Opus 4.8 (or newer), we can swap the explicit versioned entry for the alias
 * the same way.
 *
 * `claude-fable-5` is listed LAST on purpose: it is Anthropic's most capable
 * public model but bills per token (usage-based) rather than against the
 * subscription plan limit, so it's a deliberate opt-in, not the default. The
 * picker flags it with a $ icon (see `METERED_MODELS` in
 * `ModelAgentSelector.tsx`). It's an explicit versioned id (no CLI alias); the
 * CLI forwards `--model` as-is, verified working on CLI 2.1.162.
 *
 * Consumed by both the orchestrator-side `AGENT_DEFS` and the session-side
 * `ClaudeAdapter.capabilities` — keep this the only place to add a model.
 */
export const CLAUDE_MODELS = ["claude-opus-4-8", "sonnet", "haiku", "claude-fable-5"];

export const CLAUDE_TOOL_NAMES = [
  "Agent",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "ListMcpResourcesTool",
  "LSP",
  "Monitor",
  "NotebookEdit",
  "PowerShell",
  "PushNotification",
  "Read",
  "ReadMcpResourceTool",
  "RemoteTrigger",
  "ScheduleWakeup",
  "SendMessage",
  "ShareOnboardingGuide",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskStop",
  "TaskUpdate",
  "TeamCreate",
  "TeamDelete",
  "TodoWrite",
  "ToolSearch",
  "WaitForMcpServers",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
] as const;

export const CODEX_TOOL_NAMES = [
  "shell",
  "commandExecution",
  "fileChange",
  "apply_patch",
  "mcpToolCall",
  "dynamicToolCall",
  "collabToolCall",
  "spawn_agent",
  "Agent",
  "webSearch",
  "imageView",
  "view_image",
  "tool_search",
  "AskUserQuestion",
] as const;

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
      toolNames: [...CLAUDE_TOOL_NAMES],
      models: CLAUDE_MODELS,
      // Claude Code CLI `--effort <level>`. Verified valid values by running
      // `claude --effort __bogus__`: "low, medium, high, xhigh, max". Omitting
      // the flag uses the model's adaptive default. See docs/217-per-agent-reasoning.
      reasoning: {
        label: "Reasoning",
        options: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra high" },
          { value: "max", label: "Max" },
        ],
      },
      supportsReview: true,
      supportsSteering: true,
      supportsCompaction: true,
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
      toolNames: [...CODEX_TOOL_NAMES],
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
      // Codex CLI config `model_reasoning_effort`. Verified valid values by
      // running `codex -c model_reasoning_effort=__bogus__`: "none, minimal,
      // low, medium, high, xhigh". Omitting the override uses Codex's own
      // default. Passed at app-server spawn as `-c model_reasoning_effort=…`.
      // See docs/217-per-agent-reasoning.
      reasoning: {
        label: "Reasoning effort",
        options: [
          { value: "none", label: "None" },
          { value: "minimal", label: "Minimal" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra high" },
        ],
      },
      // docs/125 — Codex now ships subagents (model-invoked via the
      // `spawn_agent` collab tool, triggered by explicit instruction) AND MCP
      // servers (`[mcp_servers.*]` in config.toml). The worker writes the
      // review bridge into the Codex config; the same chat-native review flow
      // works on both backends.
      supportsReview: true,
      supportsSteering: true,
      supportsCompaction: true,
      skillsDirName: ".codex",
      skillInvocationPrefix: "$",
    },
  },
];

/**
 * Runtime list of known agent ids, derived from `AGENT_DEFS` so it can never
 * drift from the static definitions. `AgentId` is a compile-time union with no
 * runtime form, so callers that must validate an agent id supplied as free text
 * (e.g. the spawn route's `--agent`) need this to both check membership and
 * render a "valid agents: …" error message.
 */
export const KNOWN_AGENT_IDS: AgentId[] = AGENT_DEFS.map((d) => d.id);

/**
 * Map a model id to the agent that owns it, using the static `AGENT_DEFS`
 * model lists. Returns `undefined` when the model is empty or not present in
 * any agent's list (e.g. a versioned id the picker doesn't surface, or an
 * unknown model) so callers can fall back to an explicit agent / default.
 *
 * Mirrors the client's `agentIdForModel`
 * (src/client/utils/agent-for-model.ts): the model is the single source of
 * truth and the agent is derived from it, never tracked independently. Used as
 * server-side defense-in-depth so a caller that sends a mismatched agent+model
 * (e.g. a stale `vibe-agent-id`) can't pin a session to the wrong agent. See
 * docs/142 (Problem C) and docs/166-quick-capture-agent-pin.
 */
export function agentIdForModel(model: string | undefined): AgentId | undefined {
  if (!model) return undefined;
  const owner = AGENT_DEFS.find((def) => def.capabilities.models.includes(model));
  return owner?.id;
}

/**
 * Static capability lookup keyed by agent id, independent of runtime detection.
 *
 * `AgentRegistry.get(id)` only returns an entry after `detect()` has probed
 * the host, and it requires a live registry instance. The steer-or-queue
 * decision on the orchestrator's dispatch path (docs/163) runs deep inside
 * `SessionRunner.dispatch` / `ContainerSessionRunner.dispatch`, which have no
 * registry handle — they only know the runner's `agentId`. `supportsSteering`
 * is a compile-time fact about the adapter (see `AGENT_DEFS`), so expose it
 * directly from the static definitions. Returns `undefined` for an unknown id.
 */
export function getAgentCapabilities(id: AgentId): AgentCapabilities | undefined {
  return AGENT_DEFS.find((d) => d.id === id)?.capabilities;
}

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

/** Events emitted by {@link AgentRegistry}. */
export interface AgentRegistryEvents {
  /**
   * docs/144 — fired when an agent's auth transitions configured → not
   * configured (a sign-out). `services/sub-agent.ts` subscribes to sweep any
   * in-flight cross-agent credentials provisioned for a spawn from sessions
   * where this agent is NOT the pinned agent.
   */
  "sign-out": [agentId: AgentId];
}

export class AgentRegistry extends EventEmitter<AgentRegistryEvents> {
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
    super();
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
      const wasConfigured = info.authConfigured;
      info.authConfigured = this.isAuthConfigured(id);
      // docs/144 — emit on a configured → not-configured edge so the sub-agent
      // service can sweep cross-agent creds left over from a spawn.
      if (wasConfigured && !info.authConfigured) {
        this.emit("sign-out", id);
      }
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
