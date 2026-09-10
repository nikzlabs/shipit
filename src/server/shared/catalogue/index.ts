import type { AgentId } from "../types/agent-types.js";
import { HARNESSES } from "./harnesses.js";
import { SERVICES, type ServiceId } from "./services.js";
import type {
  ApiStyle,
  BillingMode,
  BillingModeDef,
  CredentialTarget,
  CredentialTargets,
  HarnessDef,
  LoginIntegrationId,
  ModeCredential,
  ModelDef,
  ModelSelection,
  QuotaIntegrationId,
  ServiceDef,
} from "./types.js";
import type { ModelIdentity } from "./model-identity.js";
import { MODEL_VISION, type VisionSupport } from "./model-vision.js";

export * from "./types.js";
export * from "./model-identity.js";
export * from "./model-vision.js";
export { HARNESSES } from "./harnesses.js";
export { SERVICES, type ServiceId } from "./services.js";

const _SERVICE_IDS_ARE_LITERAL: readonly ServiceId[] = SERVICES.map((s) => s.id);
void _SERVICE_IDS_ARE_LITERAL;

// Catalogue order determines defaults.
export function allServices(): readonly ServiceDef[] {
  return SERVICES;
}

export function allHarnesses(): readonly HarnessDef[] {
  return HARNESSES;
}

export function getService(serviceId: string): ServiceDef | undefined {
  return SERVICES.find((s) => s.id === serviceId);
}

export function getHarness(harnessId: AgentId): HarnessDef | undefined {
  return HARNESSES.find((h) => h.id === harnessId);
}

export function nativeServiceForHarness(harnessId: AgentId | undefined): string | undefined {
  return harnessId ? getHarness(harnessId)?.nativeService : undefined;
}

export function harnessForNativeService(serviceId: string): AgentId | undefined {
  return HARNESSES.find((h) => h.nativeService === serviceId)?.id;
}

export function loginIntegrationForService(
  serviceId: string | undefined,
): LoginIntegrationId | undefined {
  if (!serviceId) return undefined;
  for (const mode of getService(serviceId)?.modes ?? []) {
    for (const credential of mode.credentials) {
      if (credential.via === "account") return credential.login;
    }
  }
  return undefined;
}

export function serviceForLoginIntegration(
  loginId: LoginIntegrationId,
): ServiceId | undefined {
  return SERVICES.find((service) =>
    service.modes.some((mode) =>
      mode.credentials.some((c) => c.via === "account" && c.login === loginId),
    ),
  )?.id;
}

export function allLoginIntegrations(): LoginIntegrationId[] {
  const seen: LoginIntegrationId[] = [];
  for (const service of SERVICES) {
    for (const mode of service.modes) {
      for (const credential of mode.credentials) {
        if (credential.via === "account" && !seen.includes(credential.login)) {
          seen.push(credential.login);
        }
      }
    }
  }
  return seen;
}

/** Owns the login files; other harnesses may consume them. */
export function credentialHarnessForLogin(loginId: LoginIntegrationId): AgentId | undefined {
  const serviceId = serviceForLoginIntegration(loginId);
  return serviceId ? harnessForNativeService(serviceId) : undefined;
}

export function harnessesForLoginIntegration(loginId: LoginIntegrationId): AgentId[] {
  const serviceId = serviceForLoginIntegration(loginId);
  const service = serviceId ? getService(serviceId) : undefined;
  if (!service) return [];
  const modes = service.modes.filter((mode) =>
    mode.credentials.some((c) => c.via === "account" && c.login === loginId),
  );
  // Shared API styles do not imply account compatibility; check carriers too.
  return HARNESSES.filter(
    (harness) =>
      harness.spawn.credential.account !== undefined
      && modes.some(
        (mode) =>
          mode.credentials.some(
            (c) =>
              c.via === "account"
              && c.login === loginId
              && (!c.carriers || c.carriers.includes(harness.id)),
          )
          && mode.models.some((model) => resolveStyle(harness.id, model, "account") !== undefined),
      ),
  ).map((harness) => harness.id);
}

export function getMode(serviceId: string, billingMode: BillingMode): BillingModeDef | undefined {
  return getService(serviceId)?.modes.find((m) => m.kind === billingMode);
}

export function getModel(selection: ModelSelection): ModelDef | undefined {
  return getMode(selection.serviceId, selection.billingMode)?.models.find(
    (m) => m.id === selection.modelId,
  );
}

export function selectionExists(selection: ModelSelection): boolean {
  return getModel(selection) !== undefined;
}

export function modelIdentityFor(selection: ModelSelection): ModelIdentity | undefined {
  const model = getModel(selection);
  if (!model) return undefined;
  return { canonicalModelKey: model.canonicalModelKey, family: model.family };
}

// Harness style order is a preference order.
export function resolveStyle(harnessId: AgentId, model: ModelDef, via?: "account" | "string"): ApiStyle | undefined {
  const harness = getHarness(harnessId);
  if (!harness || (model.harnesses && !model.harnesses.includes(harnessId))) return undefined;
  const allowed = via ? harness.spawn.credential[via]?.styles : undefined;
  return harness.styles.find((style) => model.styles.includes(style) && (!allowed || allowed.includes(style)));
}

function resolveModeStyle(harnessId: AgentId, mode: BillingModeDef, model: ModelDef): ApiStyle | undefined {
  for (const credential of mode.credentials) {
    if (!harnessCredentialTarget(harnessId, credential.via)) continue;
    const style = resolveStyle(harnessId, model, credential.via);
    if (style) return style;
  }
  return undefined;
}

export function resolveEndpoint(harnessId: AgentId, selection: ModelSelection): string | undefined {
  const mode = getMode(selection.serviceId, selection.billingMode);
  const model = mode?.models.find((m) => m.id === selection.modelId);
  if (!mode || !model) return undefined;
  const style = resolveModeStyle(harnessId, mode, model);
  return style ? mode.endpoints[style] : undefined;
}

export function credentialStorageEnvNames(): string[] {
  const out: string[] = [];
  for (const service of SERVICES) {
    for (const mode of service.modes) {
      for (const credential of mode.credentials) {
        if (credential.via !== "string") continue;
        if (!out.includes(credential.storageEnv)) out.push(credential.storageEnv);
      }
    }
  }
  return out;
}

export function modeCredentialFor(
  serviceId: string,
  billingMode: BillingMode,
  via: "account" | "string",
): ModeCredential | undefined {
  return getMode(serviceId, billingMode)?.credentials.find((c) => c.via === via);
}

export function storageEnvFor(serviceId: string, billingMode: BillingMode): string | undefined {
  const credential = modeCredentialFor(serviceId, billingMode, "string");
  return credential?.via === "string" ? credential.storageEnv : undefined;
}

export function credentialModeForStorageEnv(
  envName: string,
): { serviceId: ServiceId; billingMode: BillingMode } | undefined {
  for (const service of SERVICES) {
    for (const mode of service.modes) {
      for (const credential of mode.credentials) {
        if (credential.via === "string" && credential.storageEnv === envName) {
          return { serviceId: service.id, billingMode: mode.kind };
        }
      }
    }
  }
  return undefined;
}

// Failover uses subscriptions only, regardless of credential delivery shape.
export function modeAllowsMultipleCredentials(billingMode: BillingMode): boolean {
  return billingMode === "sub";
}

// A declared quota ID does not imply an implemented reader.
const IMPLEMENTED_QUOTA_INTEGRATIONS = new Set<QuotaIntegrationId>([
  "anthropic-oauth-usage",
  "openai-chatgpt-usage",
  "zai-plan-usage",
  "xai-plan-usage",
]);

// Codex receives pushed quota updates and cannot request a refresh.
const ON_DEMAND_QUOTA_INTEGRATIONS = new Set<QuotaIntegrationId>([
  "anthropic-oauth-usage",
  "zai-plan-usage",
  "xai-plan-usage",
]);

export function modeReportsQuota(serviceId: string, billingMode: BillingMode): boolean {
  const mode = getMode(serviceId, billingMode);
  return mode?.kind === "sub" && IMPLEMENTED_QUOTA_INTEGRATIONS.has(mode.quota);
}

export function subQuotaRefreshable(serviceId: string): boolean {
  const mode = getMode(serviceId, "sub");
  return mode?.kind === "sub"
    && IMPLEMENTED_QUOTA_INTEGRATIONS.has(mode.quota)
    && ON_DEMAND_QUOTA_INTEGRATIONS.has(mode.quota);
}

export function reasoningOptionsFor(
  harnessId: AgentId,
  selection: ModelSelection | undefined,
): { value: string; label: string }[] {
  const reasoning = getHarness(harnessId)?.capabilities.reasoning;
  const options = reasoning?.options ?? [];
  if (!selection) return [...options];
  // The billing-mode gate applies before model narrowing, including shared gateway rows.
  if (reasoning?.billingModes && !reasoning.billingModes.includes(selection.billingMode)) {
    return [];
  }
  const honoured = getModel(selection)?.reasoningEfforts;
  // Absent inherits the harness list; an empty array disables all levels.
  if (!honoured) return [...options];
  const allowed = new Set(honoured);
  return options.filter((o) => allowed.has(o.value));
}

export function harnessSendsReasoningEffort(harnessId: AgentId, billingMode: BillingMode): boolean {
  const reasoning = getHarness(harnessId)?.capabilities.reasoning;
  if (!reasoning || reasoning.options.length === 0) return false;
  return reasoning.billingModes === undefined || reasoning.billingModes.includes(billingMode);
}

export function selectionHonoursEffort(
  harnessId: AgentId,
  selection: ModelSelection | undefined,
  effort: string,
): boolean {
  return reasoningOptionsFor(harnessId, selection).some((o) => o.value === effort);
}

// Unknown selections must not become image refusals.
export function visionSupportFor(selection: ModelSelection | undefined): VisionSupport {
  const key = selection ? getModel(selection)?.canonicalModelKey : undefined;
  return key ? MODEL_VISION[key] : "unverified";
}

export interface CatalogueEntry {
  selection: ModelSelection & { serviceId: ServiceId };
  service: ServiceDef;
  mode: BillingModeDef;
  model: ModelDef;
}

/** Catalogue compatibility only; does not check installed binaries or configured credentials. */
export function catalogueEntriesForHarness(harnessId: AgentId): CatalogueEntry[] {
  const out: CatalogueEntry[] = [];
  for (const service of SERVICES) {
    for (const mode of service.modes) {
      for (const model of mode.models) {
        if (resolveModeStyle(harnessId, mode, model) === undefined) continue;
        out.push({
          selection: { serviceId: service.id, billingMode: mode.kind, modelId: model.id },
          service,
          mode,
          model,
        });
      }
    }
  }
  return out;
}

export function catalogueModelIdsForHarness(harnessId: AgentId): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of catalogueEntriesForHarness(harnessId)) {
    if (seen.has(entry.model.id)) continue;
    seen.add(entry.model.id);
    out.push(entry.model.id);
  }
  return out;
}

export interface ConfiguredCredential {
  serviceId: string;
  billingMode: BillingMode;
  via: "account" | "string";
}

export function harnessCredentialTarget(
  harnessId: AgentId,
  via: "account" | "string",
): CredentialTargets["string"] | CredentialTargets["account"] | undefined {
  const spawn = getHarness(harnessId)?.spawn;
  return via === "string" ? spawn?.credential.string : spawn?.credential.account;
}

// All checks must hold for the same configured credential, not separate mode credentials.
export function harnessCanCarry(harnessId: AgentId, credential: ConfiguredCredential): boolean {
  if (harnessCredentialTarget(harnessId, credential.via) === undefined) return false;
  const declared = modeCredentialFor(credential.serviceId, credential.billingMode, credential.via);
  if (!declared) return false;
  const mode = getMode(credential.serviceId, credential.billingMode);
  if (!mode?.models.some((model) => resolveStyle(harnessId, model, credential.via) !== undefined)) return false;
  if (declared.carriers && !declared.carriers.includes(harnessId)) {
    return false;
  }
  return true;
}

export function harnessServiceSupport(
  harnessId: AgentId,
  serviceId: string,
): "all" | "some" | "none" {
  const service = getService(serviceId);
  if (!service) return "none";
  const answers = service.modes.map((mode) => harnessSupportsMode(harnessId, serviceId, mode.kind));
  if (answers.every(Boolean)) return "all";
  return answers.some(Boolean) ? "some" : "none";
}

function usableModeKeys(harnessId: AgentId, credentials: readonly ConfiguredCredential[]): Set<string> {
  const out = new Set<string>();
  for (const credential of credentials) {
    if (!harnessCanCarry(harnessId, credential)) continue;
    out.add(`${credential.serviceId}:${credential.billingMode}`);
  }
  return out;
}

/** The caller must separately check that the harness is installed. */
export function eligibleEntriesForHarness(
  harnessId: AgentId,
  credentials: readonly ConfiguredCredential[],
): CatalogueEntry[] {
  const usable = usableModeKeys(harnessId, credentials);
  return catalogueEntriesForHarness(harnessId).filter((entry) =>
    usable.has(`${entry.selection.serviceId}:${entry.selection.billingMode}`),
  );
}

// Use the real eligibility predicate with hypothetical credentials to avoid divergent rules.
export function harnessSupportsMode(
  harnessId: AgentId,
  serviceId: string,
  billingMode: BillingMode,
): boolean {
  const mode = getMode(serviceId, billingMode);
  if (!mode) return false;
  return mode.credentials.some(
    (credential) =>
      eligibleEntriesForHarness(harnessId, [{ serviceId, billingMode, via: credential.via }])
        .length > 0,
  );
}

export function harnessSupportsService(harnessId: AgentId, serviceId: string): boolean {
  const service = getService(serviceId);
  if (!service) return false;
  return service.modes.some((mode) => harnessSupportsMode(harnessId, serviceId, mode.kind));
}

export function isSelectionEligible(
  harnessId: AgentId,
  selection: ModelSelection,
  credentials: readonly ConfiguredCredential[],
): boolean {
  return eligibleEntriesForHarness(harnessId, credentials).some((entry) =>
    sameSelection(entry.selection, selection),
  );
}

export function spawnCredentialTarget(
  harnessId: AgentId,
  serviceId: string,
  billingMode: BillingMode,
): CredentialTarget | undefined {
  const credential = modeCredentialFor(serviceId, billingMode, "string");
  if (credential?.via !== "string") return undefined;
  const override = credential.targetOverride?.[harnessId];
  if (override) return override;
  const target = harnessCredentialTarget(harnessId, "string");
  return target && target.kind !== "scoped-home" ? target : undefined;
}

export interface SpawnShaping {
  serviceId: string;
  billingMode: BillingMode;
  style: ApiStyle;
  endpoint: { url: string; target: HarnessDef["spawn"]["endpoint"] };
  /** Keep the service's delivery variable separate from the CLI's input variable. */
  credential?: { sourceEnv: string; target: CredentialTarget };
}

export function resolveSpawnShaping(
  harnessId: AgentId,
  selection: ModelSelection,
): SpawnShaping | undefined {
  const harness = getHarness(harnessId);
  const mode = getMode(selection.serviceId, selection.billingMode);
  const model = mode?.models.find((m) => m.id === selection.modelId);
  if (!harness || !mode || !model) return undefined;
  const style = resolveModeStyle(harnessId, mode, model);
  const url = style ? mode.endpoints[style] : undefined;
  if (!style || !url) return undefined;
  const sourceEnv = storageEnvFor(selection.serviceId, selection.billingMode);
  const target = spawnCredentialTarget(harnessId, selection.serviceId, selection.billingMode);
  return {
    serviceId: selection.serviceId,
    billingMode: selection.billingMode,
    style,
    endpoint: { url, target: harness.spawn.endpoint },
    ...(sourceEnv && target ? { credential: { sourceEnv, target } } : {}),
  };
}

export function modesOfferingModel(modelId: string): { serviceId: ServiceId; billingMode: BillingMode }[] {
  const out: { serviceId: ServiceId; billingMode: BillingMode }[] = [];
  for (const service of SERVICES) {
    for (const mode of service.modes) {
      if (mode.models.some((m) => m.id === modelId)) {
        out.push({ serviceId: service.id, billingMode: mode.kind });
      }
    }
  }
  return out;
}

// Prefer the legacy session's native service, then catalogue order.
export function resolveModelSelection(
  modelId: string | undefined,
  preferredServiceId?: string,
): ModelSelection | undefined {
  if (!modelId) return undefined;
  const candidates = modesOfferingModel(modelId);
  if (candidates.length === 0) return undefined;
  const preferred = preferredServiceId
    ? candidates.find((c) => c.serviceId === preferredServiceId)
    : undefined;
  const chosen = preferred ?? candidates[0];
  return { serviceId: chosen.serviceId, billingMode: chosen.billingMode, modelId };
}

function modesRetiringModel(modelId: string): { serviceId: ServiceId; billingMode: BillingMode }[] {
  const out: { serviceId: ServiceId; billingMode: BillingMode }[] = [];
  for (const service of SERVICES) {
    for (const mode of service.modes) {
      if (mode.retired.some((r) => r.id === modelId)) {
        out.push({ serviceId: service.id, billingMode: mode.kind });
      }
    }
  }
  return out;
}

// Never cross services or billing modes: that could change credentials or incur metered charges.
export function retirementSuccessor(
  harnessId: AgentId,
  selection: ModelSelection,
): ModelSelection | undefined {
  const mode = getMode(selection.serviceId, selection.billingMode);
  const retired = mode?.retired.find((r) => r.id === selection.modelId);
  const harness = getHarness(harnessId);
  if (!mode || !retired || !harness) return undefined;
  const style = harness.styles.find((s) => retired.styles.includes(s));
  if (!style) return undefined;
  const successorId = retired.successors[style];
  if (!successorId) return undefined;
  const successor = mode.models.find((m) => m.id === successorId);
  if (!successor?.styles.includes(style) || !resolveModeStyle(harnessId, mode, successor)) return undefined;
  return {
    serviceId: selection.serviceId,
    billingMode: selection.billingMode,
    modelId: successorId,
  };
}

// Legacy bare IDs only. At spawn, resolve retirement with the service and mode known.
export function resolveRetiredModelId(
  harnessId: AgentId,
  modelId: string | undefined,
  preferredServiceId?: string,
): ModelSelection | undefined {
  if (!modelId) return undefined;
  const candidates = modesRetiringModel(modelId);
  const ordered = preferredServiceId
    ? [
        ...candidates.filter((c) => c.serviceId === preferredServiceId),
        ...candidates.filter((c) => c.serviceId !== preferredServiceId),
      ]
    : candidates;
  for (const candidate of ordered) {
    const successor = retirementSuccessor(harnessId, { ...candidate, modelId });
    if (successor) return successor;
  }
  return undefined;
}

export function sameSelection(a: ModelSelection | undefined, b: ModelSelection | undefined): boolean {
  if (!a || !b) return a === b;
  return a.serviceId === b.serviceId && a.billingMode === b.billingMode && a.modelId === b.modelId;
}

export function sameCredentialOwner(
  a: ModelSelection | undefined,
  b: ModelSelection | undefined,
): boolean {
  if (!a || !b) return a === b;
  return a.serviceId === b.serviceId && a.billingMode === b.billingMode;
}

export function catalogueModelLabels(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const service of SERVICES) {
    for (const mode of service.modes) {
      for (const model of mode.models) {
        if (!(model.id in out)) out[model.id] = model.label;
      }
    }
  }
  return out;
}

/** Ignores per-harness overrides; use contextWindowFor when the harness is known. */
export function catalogueContextWindows(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const service of SERVICES) {
    for (const mode of service.modes) {
      for (const model of mode.models) {
        if (!(model.id in out)) out[model.id] = model.contextWindow.default;
      }
    }
  }
  return out;
}

export function contextWindowFor(
  selection: ModelSelection,
  harnessId?: AgentId,
): number | undefined {
  const model = getModel(selection);
  if (!model) return undefined;
  const override = harnessId ? model.contextWindow.byHarness?.[harnessId] : undefined;
  return override ?? model.contextWindow.default;
}

export function serializeSelection(selection: ModelSelection): string {
  return `${selection.serviceId}:${selection.billingMode}:${selection.modelId}`;
}

export function parseSelection(raw: string | undefined): ModelSelection | undefined {
  if (!raw) return undefined;
  const first = raw.indexOf(":");
  if (first <= 0) return undefined;
  const second = raw.indexOf(":", first + 1);
  if (second <= first + 1) return undefined;
  const serviceId = raw.slice(0, first);
  const billingMode = raw.slice(first + 1, second);
  const modelId = raw.slice(second + 1);
  if (billingMode !== "sub" && billingMode !== "key") return undefined;
  if (!modelId) return undefined;
  return { serviceId, billingMode, modelId };
}
