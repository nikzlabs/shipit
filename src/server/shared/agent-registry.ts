import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import type { AgentId, AgentCapabilities } from "./types/agent-types.js";
import type { BillingMode, LoginIntegrationId } from "./catalogue/types.js";
import {
  HARNESSES,
  catalogueModelIdsForHarness,
  credentialStorageEnvNames,
  eligibleEntriesForHarness,
  harnessesForLoginIntegration,
  loginIntegrationForService,
  type ConfiguredCredential,
} from "./catalogue/index.js";
import { readInstalledHarnesses } from "./installed-harnesses.js";

const execFileAsync = promisify(execFile);

export { CLAUDE_TOOL_NAMES, CODEX_TOOL_NAMES, GROK_TOOL_NAMES, OPENCODE_TOOL_NAMES } from "./agent-tool-names.js";

// Catalogue order determines defaults; these lists are not credential-filtered.
export const CLAUDE_MODELS = catalogueModelIdsForHarness("claude");
export const CODEX_MODELS = catalogueModelIdsForHarness("codex");

export interface EligibleModel {
  serviceId: string;
  serviceName: string;
  billingMode: BillingMode;
  modelId: string;
  label: string;
  /** Shared identity across vendor and gateway IDs for the same model. */
  canonicalModelKey: string;
}

export interface AgentInfo {
  id: AgentId;
  name: string;
  binary: string;
  installed: boolean;
  /** May come from legacy probes when no credential source supplies eligibleModels. */
  hasRunnableModels: boolean;
  capabilities: AgentCapabilities;
  eligibleModels: EligibleModel[];
}

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
      models: catalogueModelIdsForHarness(harness.id),
    },
  }));

export const KNOWN_AGENT_IDS: AgentId[] = AGENT_DEFS.map((d) => d.id);

export function agentIdForModel(model: string | undefined): AgentId | undefined {
  if (!model) return undefined;
  const owner = AGENT_DEFS.find((def) => def.capabilities.models.includes(model));
  return owner?.id;
}

export function getAgentCapabilities(id: AgentId): AgentCapabilities | undefined {
  return AGENT_DEFS.find((d) => d.id === id)?.capabilities;
}

export function getAgentDisplayName(id: AgentId): string {
  return AGENT_DEFS.find((d) => d.id === id)?.name ?? id;
}

// OpenCode has no single auth variable; its credentials are per service.
const AUTH_ENV_KEYS: Partial<Record<AgentId, string>> = {
  codex: "OPENAI_API_KEY",
  grok: "XAI_API_KEY",
};

export function getAuthEnvKey(agentId: AgentId): string | null {
  return AUTH_ENV_KEYS[agentId] ?? null;
}

export const ALLOWED_ENV_KEYS = new Set<string>([
  ...credentialStorageEnvNames(),
  "OPENAI_API_KEY",
]);

const MCP_ENV_KEY_PREFIX = "mcp__";

export function isAllowedAgentEnvKey(key: string): boolean {
  return ALLOWED_ENV_KEYS.has(key) || key.startsWith(MCP_ENV_KEY_PREFIX);
}

export {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  MODEL_CONTEXT_WINDOWS,
  getContextWindowForModel,
} from "./model-windows.js";

export interface AgentRegistryEvents {
  "sign-out": [agentId: AgentId];
}

export class AgentRegistry extends EventEmitter<AgentRegistryEvents> {
  private agents = new Map<AgentId, AgentInfo>();
  private checkBinary: (binary: string) => Promise<boolean>;
  private checkClaudeAuth: () => boolean;
  private checkCodexAuth: () => boolean;
  private declaredHarnesses: () => AgentId[] | null;
  private listCredentials: (() => ConfiguredCredential[]) | undefined;

  constructor(opts?: {
    checkBinary?: (binary: string) => Promise<boolean>;
    checkClaudeAuth?: () => boolean;
    checkCodexAuth?: () => boolean;
    declaredHarnesses?: () => AgentId[] | null;
    listCredentials?: () => ConfiguredCredential[];
  }) {
    super();
    this.checkBinary = opts?.checkBinary ?? defaultCheckBinary;
    this.checkClaudeAuth = opts?.checkClaudeAuth ?? (() => true);
    this.checkCodexAuth = opts?.checkCodexAuth ?? (() => false);
    this.declaredHarnesses = opts?.declaredHarnesses ?? (() => readInstalledHarnesses());
    this.listCredentials = opts?.listCredentials;
  }

  async detect(): Promise<void> {
    // The image declaration takes precedence over this container's PATH.
    const declared = this.declaredHarnesses();
    for (const def of AGENT_DEFS) {
      const installed = declared ? declared.includes(def.id) : await this.checkBinary(def.binary);
      const eligibleModels = this.computeEligibleModels(def.id);
      this.agents.set(def.id, {
        id: def.id,
        name: def.name,
        binary: def.binary,
        installed,
        hasRunnableModels: this.deriveHasRunnableModels(def.id, eligibleModels),
        capabilities: this.capabilitiesFor(def, eligibleModels),
        eligibleModels,
      });
    }
  }

  get(id: AgentId): AgentInfo | undefined {
    return this.agents.get(id);
  }

  list(): AgentInfo[] {
    return Array.from(this.agents.values());
  }

  available(): AgentInfo[] {
    return this.list().filter((a) => a.installed && a.hasRunnableModels);
  }

  refreshAuth(id: AgentId): void {
    const info = this.agents.get(id);
    if (!info) return;
    const def = AGENT_DEFS.find((d) => d.id === id);
    const wasRunnable = info.hasRunnableModels;
    info.eligibleModels = this.computeEligibleModels(id);
    info.hasRunnableModels = this.deriveHasRunnableModels(id, info.eligibleModels);
    if (def) info.capabilities = this.capabilitiesFor(def, info.eligibleModels);
    if (wasRunnable && !info.hasRunnableModels) {
      this.emit("sign-out", id);
    }
  }

  // One login can affect multiple harnesses.
  refreshAuthForLogin(loginId: LoginIntegrationId): void {
    for (const harnessId of harnessesForLoginIntegration(loginId)) this.refreshAuth(harnessId);
  }

  private computeEligibleModels(id: AgentId): EligibleModel[] {
    const configured = this.listCredentials?.();
    if (!configured) return [];
    const credentials = [...configured, ...this.probedCredentialsFor(id)];
    return eligibleEntriesForHarness(id, credentials).map((entry) => ({
      serviceId: entry.selection.serviceId,
      serviceName: entry.service.name,
      billingMode: entry.selection.billingMode,
      modelId: entry.model.id,
      label: entry.model.label,
      canonicalModelKey: entry.model.canonicalModelKey,
    }));
  }

  // Probes must report account evidence only: an API key is not a subscription.
  private probedCredentialsFor(id: AgentId): ConfiguredCredential[] {
    const nativeService = HARNESSES.find((h) => h.id === id)?.nativeService;
    if (!nativeService) return [];
    if (!loginIntegrationForService(nativeService)) return [];
    const probed = id === "claude" ? this.checkClaudeAuth() : id === "codex" ? this.checkCodexAuth() : false;
    if (!probed) return [];
    return [{ serviceId: nativeService, billingMode: "sub", via: "account" }];
  }

  private capabilitiesFor(
    def: (typeof AGENT_DEFS)[number],
    eligibleModels: EligibleModel[],
  ): AgentCapabilities {
    if (!this.listCredentials) return def.capabilities;
    const ids: string[] = [];
    for (const model of eligibleModels) {
      if (!ids.includes(model.modelId)) ids.push(model.modelId);
    }
    return { ...def.capabilities, models: ids };
  }

  private deriveHasRunnableModels(id: AgentId, eligibleModels: EligibleModel[]): boolean {
    if (this.listCredentials) return eligibleModels.length > 0;
    // Workers and legacy tests have no credential source; retain their probe fallback.
    if (id === "claude") {
      return this.checkClaudeAuth();
    }
    if (id === "codex") {
      if (this.checkCodexAuth()) return true;
    }
    const envKey = getAuthEnvKey(id);
    if (!envKey) return false;
    const val = process.env[envKey];
    return typeof val === "string" && val.length > 0;
  }
}

async function defaultCheckBinary(binary: string): Promise<boolean> {
  try {
    await execFileAsync("which", [binary], { stdio: "ignore" } as never);
    return true;
  } catch {
    return false;
  }
}
