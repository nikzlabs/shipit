/**
 * AgentRegistry — which agent CLIs this install has, and whether their
 * credentials are configured. Used by the server to expose agent availability to
 * clients and to validate `set_agent` requests.
 *
 * docs/252 phase 9 (req 14) — "installed" is the **declared** set when the image
 * build declared one (`/opt/shipit/agents/installed.json`), and a `which` probe
 * only when it did not. See `installed-harnesses.ts` for why the declaration wins.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import type { AgentId, AgentCapabilities } from "./types/agent-types.js";
import type { BillingMode } from "./catalogue/types.js";
import {
  HARNESSES,
  catalogueModelIdsForHarness,
  credentialStorageEnvNames,
  eligibleEntriesForHarness,
  type ConfiguredCredential,
} from "./catalogue/index.js";
import { readInstalledHarnesses } from "./installed-harnesses.js";

const execFileAsync = promisify(execFile);

// docs/252 phase 1 — tool names moved to their own module so the harness
// catalogue can carry them without closing an import cycle with this file.
// Re-exported here so existing import sites are unchanged.
export { CLAUDE_TOOL_NAMES, CODEX_TOOL_NAMES } from "./agent-tool-names.js";

/**
 * docs/252 — the model lists are DERIVED from the service catalogue.
 *
 * They used to be hand-kept arrays here, which is the `AgentId` conflation this
 * feature removes: a harness is a CLI to spawn, and which models exist is a
 * property of the *service*.
 *
 * **The whole join, not just the harness's own vendor.** Phase 1 narrowed these
 * to `nativeService` because nothing could yet give a custom service a
 * credential or route a turn to one; phase 3 can, so the narrowing goes. These
 * are the *catalogue's* answer — what this CLI could speak to — and are used
 * where no credential question is being asked: the worker-side adapter's static
 * capability block and {@link agentIdForModel}. What the picker offers is the
 * CREDENTIAL-FILTERED subset, computed per install in {@link AgentRegistry}.
 *
 * Order still matters exactly as it did: `models[0]` is the default a fresh
 * install runs with (the server's connect-time fallback and the client picker's
 * first-model fallback both resolve to the first entry), so the ordering
 * *within* a mode in `catalogue/services.ts` is what decides it — and the
 * first-party services still sort first, so no default moved.
 */
export const CLAUDE_MODELS = catalogueModelIdsForHarness("claude");

/** See {@link CLAUDE_MODELS} — the same join for the `codex` harness. */
export const CODEX_MODELS = catalogueModelIdsForHarness("codex");

// docs/252 phase 8 — `normalizeCodexModelId` lived here: a shim that mapped the
// retired unsuffixed GPT-5.6 slug onto Sol for one service, one style and one
// harness. Retirement is now resolved once, where the service and billing mode
// are known: `retirementSuccessor` (`catalogue/index.ts`) reads the catalogue's
// per-mode record, and `applyModelRetirement` (orchestrator) persists the
// successor onto the session so the picker agrees with what is running (req 13).
// Deliberately NOT re-created as a bare-id helper for a spawn boundary to call —
// see the note beside `retirementSuccessor` for why an id alone cannot say whose
// retirement applies.

/**
 * docs/252 phase 3 (req 8) — one model the picker may offer, as the identity it
 * is actually selected by.
 *
 * The entry is the **triple**, not a model id: the same id is reachable through
 * a vendor directly and through a gateway, and through two modes of one service,
 * at different prices — so an id alone cannot say who is billing you (req 11).
 * `serviceName` and `label` ride along because the picker groups on the service
 * and the client has no catalogue of its own to look them up in.
 */
export interface EligibleModel {
  serviceId: string;
  serviceName: string;
  billingMode: BillingMode;
  modelId: string;
  label: string;
}

export interface AgentInfo {
  id: AgentId;
  name: string;
  binary: string;
  installed: boolean;
  /**
   * docs/252 phase 3 — **"this harness has at least one model it can run"**,
   * which is the same question as before for a first-party install and a
   * different one for req 2's case: a user whose only credential is a DeepSeek
   * key now has Claude Code configured, with no Anthropic account anywhere.
   *
   * The field keeps its name because it is still the gate every "can this
   * harness take a turn" site asks (`agent-auth-gate.ts`, `set_agent`, the
   * sub-agent spawn), and renaming it across those sites is churn without a
   * behaviour change. What moved is what it MEANS: a per-`AgentId` credential
   * probe became the per-model rule of req 8, evaluated over the harness's own
   * eligible set. `AgentRegistry.available()` is unchanged and still the
   * conjunction with `installed` (req 14).
   */
  authConfigured: boolean;
  capabilities: AgentCapabilities;
  /**
   * The credential-filtered join for this install, in catalogue order (req 8).
   * `capabilities.models` is this list's model ids, de-duplicated — kept because
   * many call sites still speak bare ids, and exactly consistent with this
   * because both are derived from it.
   */
  eligibleModels: EligibleModel[];
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
      models: catalogueModelIdsForHarness(harness.id),
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
export const ALLOWED_ENV_KEYS = new Set<string>([
  // docs/252 phase 2 — every `storageEnv` the catalogue declares, so a new
  // service's key name is one catalogue edit rather than an edit here as well.
  // `ALLOWED_ENV_KEYS` stays a compile-time constant (Appendix A): the
  // requirement that once justified a runtime mechanism — "trying a new service
  // needs no release" — disappeared when the catalogue itself started shipping
  // with ShipIt, so the mechanism should not survive it.
  ...credentialStorageEnvNames(),
  // Kept explicitly rather than left to the catalogue: this is the historical
  // entry, and `set_agent_env` writes flowing through it predate the catalogue.
  "OPENAI_API_KEY",
]);

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

  /**
   * docs/252 phase 9 — the harness set this install declares, or `null` when it
   * declares none (a checkout, a test, a pre-feature image) and `checkBinary` is
   * the answer instead. Injectable so a test can assert either mode.
   */
  private declaredHarnesses: () => AgentId[] | null;

  /**
   * docs/252 phase 3 (req 8) — the credentials the user has configured, as
   * eligibility sees them. Injected rather than read here because this module is
   * `shared/` and the credential store is the orchestrator's; the wiring site is
   * `app-di.ts`.
   *
   * Absent ⇒ **fall back to the account probes**, which is what a worker-side or
   * test registry has. Returning an empty list instead would be worse than
   * wrong: it would report every harness unconfigured and empty every model
   * list, in the two contexts least able to notice.
   */
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

  /**
   * Resolve which agent CLIs this install has.
   *
   * Prefers the build's declared set over a `which` probe: the deployment's
   * harness selection is the fact (req 14), and a probe answers the narrower
   * question of what happens to be on *this* container's $PATH. Read once here
   * rather than per harness so one report backs the whole pass.
   */
  async detect(): Promise<void> {
    const declared = this.declaredHarnesses();
    for (const def of AGENT_DEFS) {
      const installed = declared ? declared.includes(def.id) : await this.checkBinary(def.binary);
      const eligibleModels = this.computeEligibleModels(def.id);
      this.agents.set(def.id, {
        id: def.id,
        name: def.name,
        binary: def.binary,
        installed,
        authConfigured: this.isAuthConfigured(def.id, eligibleModels),
        capabilities: this.capabilitiesFor(def, eligibleModels),
        eligibleModels,
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

  /**
   * Re-check auth status for a specific agent.
   *
   * docs/252 phase 3 — this now also recomputes the eligible model set, because
   * the two answer the same question at different granularities. Every
   * credential write already calls this (phase 2 wired it so a saved key made
   * its agent selectable), so the picker's rows follow a credential change
   * without a second notification path.
   */
  refreshAuth(id: AgentId): void {
    const info = this.agents.get(id);
    if (!info) return;
    const def = AGENT_DEFS.find((d) => d.id === id);
    const wasConfigured = info.authConfigured;
    info.eligibleModels = this.computeEligibleModels(id);
    info.authConfigured = this.isAuthConfigured(id, info.eligibleModels);
    if (def) info.capabilities = this.capabilitiesFor(def, info.eligibleModels);
    // docs/144 — emit on a configured → not-configured edge so the sub-agent
    // service can sweep cross-agent creds left over from a spawn.
    if (wasConfigured && !info.authConfigured) {
      this.emit("sign-out", id);
    }
  }

  /**
   * req 8, evaluated for this install: the catalogue join narrowed to the modes
   * holding a credential this harness can carry.
   *
   * Empty when no credential source is wired — see {@link listCredentials} for
   * why that is not the same as "nothing is eligible", and
   * {@link isAuthConfigured} for how the probe fallback covers it.
   */
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
    }));
  }

  /**
   * The legacy per-`AgentId` auth probe, translated into the one credential it
   * can be describing: **an account of this harness's own vendor's
   * subscription**.
   *
   * This is the residue of `checkClaudeAuth` / `checkCodexAuth`, and it is
   * additive — it can only ever widen a harness's eligible set, never narrow
   * one, so req 2's DeepSeek-only install is unaffected by it. Two callers still
   * need it and neither is reachable from the credential store:
   *
   *  - the **injected auth manager** the DI boundary keeps as an auth source for
   *    tests and custom runtimes that do not persist provider-account rows; and
   *  - Codex's **`auth.json` file probe**, a ChatGPT login on disk that the
   *    orchestrator's route store does not own.
   *
   * Translating rather than short-circuiting is what keeps ONE rule: eligibility
   * is a question about credentials, so a legacy credential becomes a credential
   * rather than a second way to answer "is this harness configured". The
   * alternative — OR-ing the probe into `authConfigured` — would report a
   * harness runnable while its picker had no rows, which is the state req 8
   * exists to prevent.
   */
  private probedCredentialsFor(id: AgentId): ConfiguredCredential[] {
    const nativeService = HARNESSES.find((h) => h.id === id)?.nativeService;
    if (!nativeService) return [];
    const probed = id === "claude" ? this.checkClaudeAuth() : id === "codex" ? this.checkCodexAuth() : false;
    if (!probed) return [];
    return [{ serviceId: nativeService, billingMode: "sub", via: "account" }];
  }

  /** `capabilities`, with `models` narrowed to what this install can actually run. */
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

  /**
   * docs/252 phase 3 — "can this harness run anything here?", answered from the
   * per-model rule (req 8) when a credential source is wired.
   *
   * That is the whole of req 2: a DeepSeek key makes Claude Code configured, and
   * a lapsed Anthropic subscription with no key makes it not — one rule, no
   * vendor special-cased. The probes below survive only as the fallback for a
   * registry with no credential source (a worker, a unit test); they are the
   * pre-feature behaviour and are per-`AgentId` by construction.
   */
  private isAuthConfigured(id: AgentId, eligibleModels: EligibleModel[]): boolean {
    if (this.listCredentials) return eligibleModels.length > 0;
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
