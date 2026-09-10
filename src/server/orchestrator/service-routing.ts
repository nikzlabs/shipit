import type { AgentId, ServiceRouting, SessionInfo } from "../shared/types.js";
import { selectionOf } from "./turn-attribution.js";
import type {
  AccountSelection,
  ProviderAccountManager,
  ProviderRoute,
  SelectAccountOptions,
} from "./provider-account-manager.js";
import {
  accountServiceForHarness,
  isOverCutoff,
  orderForSelectionMode,
  snapshotExhaustedResetAt,
} from "./provider-account-manager.js";
import type { CredentialStore } from "./credential-store.js";
import type { BillingMode, ModelSelection } from "../shared/catalogue/index.js";
import {
  SERVICES,
  type ConfiguredCredential,
  eligibleEntriesForHarness,
  getMode,
  getModel,
  resolveStyle,
  getService,
  harnessCanCarry,
  modeCredentialFor,
  resolveSpawnShaping,
  storageEnvFor,
} from "../shared/catalogue/index.js";
import type { CredentialRoute } from "../shared/types/domain-types/credential-route.js";
import {
  credentialRouteEnvName,
  orderCredentialRoutes,
  refusalBlockedUntil,
} from "../shared/types/domain-types/credential-route.js";
import type { AccountSelectionMode, ProviderRouteKind } from "../shared/types/domain-types/provider.js";

export type ServiceRoutingCredentialSource = Pick<
  CredentialStore,
  | "listCredentialRoutes"
  | "getCredentialSecret"
  | "getSelectionMode"
  | "getCredentialRoute"
  | "getFailoverCutoffs"
>;

// Preserve IDs already pinned by existing sessions.
const LEGACY_RESERVED_ROUTE_IDS: Record<string, string> = {
  ANTHROPIC_AUTH_TOKEN: "claude-env-oauth",
  ANTHROPIC_API_KEY: "claude-api-key",
  OPENAI_API_KEY: "codex-api-key",
};

export function envRouteIdFor(storageEnv: string): string {
  return LEGACY_RESERVED_ROUTE_IDS[storageEnv] ?? `env:${storageEnv}`;
}

export function credentialOwnerForRouteId(
  routeId: string,
  credentialStore: Pick<CredentialStore, "getCredentialRoute">,
): { serviceId: string; billingMode: BillingMode } | undefined {
  const stored = credentialStore.getCredentialRoute(routeId);
  if (stored) return { serviceId: stored.serviceId, billingMode: stored.billingMode };
  // Deployment credentials can exist without a stored row.
  for (const service of servicesWithStringCredentials()) {
    if (envRouteIdFor(service.storageEnv) === routeId) {
      return { serviceId: service.serviceId, billingMode: service.billingMode };
    }
  }
  return undefined;
}

export function listConfiguredCredentials(
  credentialStore: ServiceRoutingCredentialSource,
  env: NodeJS.ProcessEnv = process.env,
  // Permanent defaults must not select an unfinished sign-in.
  opts: { requireReadyAccounts?: boolean } = {},
): ConfiguredCredential[] {
  const out: ConfiguredCredential[] = [];
  const seen = new Set<string>();
  const add = (serviceId: string, billingMode: BillingMode, via: "account" | "string"): void => {
    const key = `${serviceId}:${billingMode}:${via}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ serviceId, billingMode, via });
  };
  for (const route of credentialStore.listCredentialRoutes()) {
    if (route.via === "string" && !credentialStore.getCredentialSecret(route.id)) continue;
    if (route.via === "account" && route.status !== "ready" && route.status !== "authenticating") {
      continue;
    }
    if (opts.requireReadyAccounts && route.via === "account" && route.status !== "ready") continue;
    add(route.serviceId, route.billingMode, route.via);
  }
  for (const service of servicesWithStringCredentials()) {
    const value = env[service.storageEnv];
    if (typeof value === "string" && value.trim().length > 0) {
      add(service.serviceId, service.billingMode, "string");
    }
  }
  return out;
}

// Use the picker's ordering for sessions without a stored selection.
export function firstEligibleSelectionForHarness(
  harnessId: AgentId,
  deps: Pick<SelectRouteDeps, "credentialStore" | "env">,
): ModelSelection | undefined {
  const credentials = listConfiguredCredentials(deps.credentialStore, deps.env ?? process.env);
  return eligibleEntriesForHarness(harnessId, credentials)[0]?.selection;
}

function servicesWithStringCredentials(): {
  serviceId: string;
  billingMode: BillingMode;
  storageEnv: string;
}[] {
  const out: { serviceId: string; billingMode: BillingMode; storageEnv: string }[] = [];
  for (const service of SERVICES) {
    for (const mode of service.modes) {
      const storageEnv = storageEnvFor(service.id, mode.kind);
      if (storageEnv) out.push({ serviceId: service.id, billingMode: mode.kind, storageEnv });
    }
  }
  return out;
}

export interface SelectRouteDeps {
  credentialStore: ServiceRoutingCredentialSource;
  providerAccountManager?: Pick<
    ProviderAccountManager,
    "selectAccountForTurn" | "subscriptionLimitsFor"
  >;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export function selectRouteForSelection(
  harnessId: AgentId,
  selection: ModelSelection | undefined,
  deps: SelectRouteDeps,
  opts: SelectAccountOptions = {},
): AccountSelection {
  const mode = selection ? getMode(selection.serviceId, selection.billingMode) : undefined;
  if (!selection || !mode) {
    // Turn preparation must resolve an eligible selection before this fallback.
    return (
      deps.providerAccountManager?.selectAccountForTurn(accountServiceForHarness(harnessId), opts)
      ?? { ok: false, reason: "auth_required" }
    );
  }

  const acceptsAccount =
    modeCredentialFor(selection.serviceId, selection.billingMode, "account") !== undefined
    && harnessCanCarry(harnessId, { ...selection, via: "account" });

  if (acceptsAccount && deps.providerAccountManager) {
    const selected = deps.providerAccountManager.selectAccountForTurn(selection.serviceId, opts);
    // Its string fallback ignores billing mode; resolve strings separately below.
    if (selected.ok && selected.route.kind === "account") return selected;
    // Untracked environment tokens must not bypass exhausted subscriptions.
    if (!selected.ok && selected.reason === "all_exhausted") return selected;
  }

  return stringSelectionFor(harnessId, selection, deps, opts);
}

function stringSelectionFor(
  harnessId: AgentId,
  selection: ModelSelection,
  deps: SelectRouteDeps,
  opts: SelectAccountOptions = {},
): AccountSelection {
  if (!harnessCanCarry(harnessId, { ...selection, via: "string" })) {
    return { ok: false, reason: "auth_required" };
  }
  const exclude = new Set(opts.exclude ?? []);
  const stored = deps.credentialStore
    .listCredentialRoutes(selection.serviceId, selection.billingMode)
    .filter((route) => route.via === "string" && deps.credentialStore.getCredentialSecret(route.id));

  if (stored.length > 0) {
    if (selection.billingMode !== "sub") {
      return { ok: true, route: { kind: "reserved", id: orderCredentialRoutes(stored)[0].id } };
    }
    const now = deps.now?.() ?? Date.now();
    const mode = deps.credentialStore.getSelectionMode(selection.serviceId, selection.billingMode);
    const ordered = orderStringCredentials(stored, mode)
      .filter((route) => !exclude.has(route.id));
    // Balanced mode spreads sessions; rotating each turn would restart resident processes.
    if (mode === "balanced" && opts.residentRouteId) {
      const resident = ordered.find(
        (route) => route.id === opts.residentRouteId && refusalBlockedUntil(route, now) === null,
      );
      if (resident) return { ok: true, route: { kind: "reserved", id: resident.id } };
    }
    // Quota telemetry changes order. Only refusal memory excludes a credential.
    const limits = deps.providerAccountManager?.subscriptionLimitsFor(
      selection.serviceId,
      selection.billingMode,
    ) ?? {};
    const cutoffs = deps.credentialStore.getFailoverCutoffs(
      selection.serviceId,
      selection.billingMode,
    );
    const clear: CredentialRoute[] = [];
    const overCutoff: CredentialRoute[] = [];
    const looksSpent: CredentialRoute[] = [];
    for (const route of ordered) {
      if (refusalBlockedUntil(route, now) !== null) continue;
      if (snapshotExhaustedResetAt(limits[route.id], now) !== null) looksSpent.push(route);
      else if (isOverCutoff(limits[route.id], cutoffs, now)) overCutoff.push(route);
      else clear.push(route);
    }
    const next = [...clear, ...overCutoff, ...looksSpent][0];
    if (next) return { ok: true, route: { kind: "reserved", id: next.id } };
    const probe = ordered[0];
    if (opts.optimistic && probe) return { ok: true, route: { kind: "reserved", id: probe.id } };
    const benched = ordered
      .map((route) => refusalBlockedUntil(route, now))
      .filter((until): until is number => typeof until === "number");
    return {
      ok: false,
      reason: "all_exhausted",
      earliestResetAt: benched.length > 0 ? new Date(Math.min(...benched)).toISOString() : null,
    };
  }

  // Environment credentials are a fallback only when nothing is stored.
  const storageEnv = storageEnvFor(selection.serviceId, selection.billingMode);
  const fromEnv = storageEnv ? (deps.env ?? process.env)[storageEnv] : undefined;
  if (storageEnv && typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return { ok: true, route: { kind: "reserved", id: envRouteIdFor(storageEnv) } };
  }
  return { ok: false, reason: "auth_required" };
}

function orderStringCredentials(
  routes: readonly CredentialRoute[],
  mode: AccountSelectionMode,
): CredentialRoute[] {
  return orderForSelectionMode(orderCredentialRoutes(routes), mode);
}

export function markCredentialRouteUsed(
  credentialStore: Pick<CredentialStore, "markCredentialRouteUsed">,
  route: ProviderRoute | undefined,
): void {
  if (route?.kind !== "reserved") return;
  credentialStore.markCredentialRouteUsed(route.id);
}

export function residentRouteNeedsRelease(
  session: SessionInfo | undefined,
  harnessId: AgentId,
  runner:
    | {
        residentRoute?: { kind: ProviderRouteKind; id: string } | undefined;
        backgroundWorkDescriptions?: readonly string[];
      }
    | null
    | undefined,
  deps: SelectRouteDeps,
): boolean {
  const resident = runner?.residentRoute;
  if (!session || !resident) return false;
  // Defer credential changes while the process owns background work.
  if ((runner?.backgroundWorkDescriptions?.length ?? 0) > 0) return false;
  const selection = selectRouteForSelection(harnessId, selectionOf(session), deps, {
    optimistic: true,
    residentRouteId: resident.id,
  });
  if (!selection.ok) return false;
  return selection.route.kind !== resident.kind || selection.route.id !== resident.id;
}

export function serviceRoutingForSelection(
  harnessId: AgentId,
  selection: ModelSelection | undefined,
  route: ProviderRoute | null | undefined,
  credentialStore: Pick<CredentialStore, "getCredentialRoute">,
): ServiceRouting | undefined {
  if (!selection) return undefined;
  if (route?.kind === "account") {
    if (harnessId === "opencode" && selection.serviceId === "openai" && selection.billingMode === "sub") {
      const model = getModel(selection);
      const mode = getMode(selection.serviceId, selection.billingMode);
      const style = model && resolveStyle(harnessId, model, "account");
      const baseUrl = style && mode?.endpoints[style];
      if (style !== "openai-responses" || !baseUrl) return undefined;
      return {
        serviceId: "openai", serviceName: "OpenAI", billingMode: "sub",
        style, baseUrl,
        credentialTarget: { kind: "openai-chatgpt", accountId: route.id },
      };
    }
    return undefined;
  }
  // Without a resolved route, do not guess between account and string delivery.
  if (
    !route
    && modeCredentialFor(selection.serviceId, selection.billingMode, "account") !== undefined
  ) {
    return undefined;
  }
  const shaping = resolveSpawnShaping(harnessId, selection);
  if (!shaping?.credential) return undefined;
  const service = getService(selection.serviceId);
  return {
    serviceId: shaping.serviceId,
    serviceName: service?.name ?? shaping.serviceId,
    billingMode: shaping.billingMode,
    style: shaping.style,
    baseUrl: shaping.endpoint.url,
    // Stored credentials have per-route variables, including adopted legacy IDs.
    credentialSourceEnv:
      route?.kind === "reserved" && credentialStore.getCredentialRoute(route.id)
        ? credentialRouteEnvName(route.id)
        : shaping.credential.sourceEnv,
    credentialTarget: shaping.credential.target,
  };
}

// Read the resolved credential so authentication matches usage attribution.
export function credentialSecretForRoute(
  deps: {
    credentialStore: Pick<CredentialStore, "getCredentialSecret">;
    env?: NodeJS.ProcessEnv | undefined;
  },
  selection: ModelSelection,
  sourceEnv: string,
  route: ProviderRoute | null | undefined,
): string | undefined {
  if (route?.kind === "account") return undefined;
  if (route?.kind === "reserved") {
    const stored = deps.credentialStore.getCredentialSecret(route.id);
    if (stored) return stored;
  }
  const storageEnv = storageEnvFor(selection.serviceId, selection.billingMode);
  if (storageEnv !== sourceEnv) return undefined;
  const fromEnv = (deps.env ?? process.env)[sourceEnv];
  return typeof fromEnv === "string" && fromEnv.trim().length > 0 ? fromEnv : undefined;
}

export function desiredSpawnIdentity(
  sessionManager: { get(id: string): SessionInfo | undefined },
  sessionId: string,
  harnessId: AgentId,
): string | undefined {
  const session = sessionManager.get(sessionId);
  return session ? sessionSpawnIdentity(session, harnessId) : undefined;
}

export function sessionSpawnIdentity(
  session: Pick<SessionInfo, "model" | "serviceId" | "billingMode">,
  harnessId: AgentId,
): string {
  const selection =
    session.serviceId && session.billingMode && session.model
      ? { serviceId: session.serviceId, billingMode: session.billingMode, modelId: session.model }
      : undefined;
  const shaping = selection ? resolveSpawnShaping(harnessId, selection) : undefined;
  // Credential identity is compared separately against the resident route each turn.
  return [
    harnessId,
    session.serviceId ?? "-",
    session.billingMode ?? "-",
    session.model ?? "-",
    shaping?.style ?? "-",
    shaping?.endpoint.url ?? "-",
  ].join("|");
}

// The spawn stamp stays fixed even if the session row changes during a turn.
export function parseSpawnIdentity(
  identity: string | undefined,
): { harnessId: AgentId; selection?: ModelSelection } | undefined {
  if (!identity) return undefined;
  const [harnessId, serviceId, billingMode, modelId] = identity.split("|");
  if (!harnessId) return undefined;
  const complete =
    serviceId && serviceId !== "-"
    && (billingMode === "sub" || billingMode === "key")
    && modelId && modelId !== "-";
  return complete
    ? { harnessId: harnessId as AgentId, selection: { serviceId, billingMode, modelId } }
    : { harnessId: harnessId as AgentId };
}
