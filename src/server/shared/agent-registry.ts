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
import { HARNESSES, nativeModelIdsForHarness } from "./catalogue/index.js";

const execFileAsync = promisify(execFile);

// docs/252 phase 1 — tool names moved to their own module so the harness
// catalogue can carry them without closing an import cycle with this file.
// Re-exported here so existing import sites are unchanged.
export { CLAUDE_TOOL_NAMES, CODEX_TOOL_NAMES } from "./agent-tool-names.js";

/**
 * docs/252 phase 1 — the model lists are DERIVED from the service catalogue.
 *
 * They used to be hand-kept arrays here, which is the `AgentId` conflation this
 * feature removes: a harness is a CLI to spawn, and which models exist is a
 * property of the *service*. `nativeModelIdsForHarness` returns the models the
 * harness's own vendor's service declares, de-duplicated across billing modes
 * and in catalogue order.
 *
 * **Restricted to the native service on purpose.** The catalogue also carries
 * DeepSeek, the gateways and GLM, and the join would offer them here — but
 * there is no way to give them a credential (phase 2) or route a turn to them
 * (phase 3) yet, so phase 1 narrows to `nativeService` and nothing user-visible
 * moves. `catalogue.test.ts` pins both lists against what shipped before the
 * catalogue existed. Phase 3 replaces both with the credential-filtered join.
 *
 * Order still matters exactly as it did: `models[0]` is the default a fresh
 * install runs with (the server's connect-time fallback and the client picker's
 * `activeAgent?.models[0]` both resolve to the first entry), so the ordering
 * *within* a mode in `catalogue/services.ts` is what decides it.
 */
export const CLAUDE_MODELS = nativeModelIdsForHarness("claude");

/** See {@link CLAUDE_MODELS} — derived from the `openai` service's rows. */
export const CODEX_MODELS = nativeModelIdsForHarness("codex");

// docs/252 phase 8 — `normalizeCodexModelId` lived here: a shim that mapped the
// retired unsuffixed GPT-5.6 slug onto Sol for one service, one style and one
// harness. Retirement is now resolved once, where the service and billing mode
// are known: `retirementSuccessor` (`catalogue/index.ts`) reads the catalogue's
// per-mode record, and `applyModelRetirement` (orchestrator) persists the
// successor onto the session so the picker agrees with what is running (req 13).
// Deliberately NOT re-created as a bare-id helper for a spawn boundary to call —
// see the note beside `retirementSuccessor` for why an id alone cannot say whose
// retirement applies.

export interface AgentInfo {
  id: AgentId;
  name: string;
  binary: string;
  installed: boolean;
  authConfigured: boolean;
  capabilities: AgentCapabilities;
}

/**
 * Agent metadata definitions (static), derived from the harness catalogue.
 *
 * `HarnessDef.capabilities` is `Omit<AgentCapabilities, "models">` — that single
 * removal is the type-level content of docs/252 — so this join is the one place
 * the harness's capabilities and the service's model list come back together.
 */
const AGENT_DEFS: { id: AgentId; name: string; binary: string; capabilities: AgentCapabilities }[] =
  HARNESSES.map((harness) => ({
    id: harness.id,
    name: harness.name,
    binary: harness.binary,
    capabilities: {
      ...harness.capabilities,
      supportedPermissionModes: [...harness.capabilities.supportedPermissionModes],
      toolNames: [...harness.capabilities.toolNames],
      ...(harness.capabilities.reasoning
        ? {
            reasoning: {
              label: harness.capabilities.reasoning.label,
              options: harness.capabilities.reasoning.options.map((o) => ({ ...o })),
            },
          }
        : {}),
      models: nativeModelIdsForHarness(harness.id),
    },
  }));

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
