import { randomUUID } from "node:crypto";
import {
  orderCredentialRoutes,
  type CredentialBillingMode,
  type CredentialRoute,
} from "../../shared/types.js";
import {
  allServices,
  getMode,
  getService,
  modeAllowsMultipleCredentials,
  modeCredentialFor,
  storageEnvFor,
  type BillingModeDef,
  type ServiceDef,
} from "../../shared/catalogue/index.js";
import type { CredentialStore } from "../credential-store.js";
import { collectServiceCredentialEnv } from "../secret-resolver.js";
import { envRouteIdFor } from "../service-routing.js";
import { ServiceError } from "./types.js";
import type { SessionRunnerRegistry } from "../session-runner.js";

function generatedLabel(serviceName: string, billingMode: CredentialBillingMode, taken: Set<string>): string {
  const base = billingMode === "sub" ? `${serviceName} plan` : `${serviceName} key`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function listCredentialRoutes(credentialStore: CredentialStore): CredentialRoute[] {
  const out: CredentialRoute[] = [];
  const seen = new Set<string>();
  for (const service of allServices()) {
    for (const mode of service.modes) {
      const group = credentialStore.listCredentialRoutes(service.id, mode.kind);
      for (const route of orderCredentialRoutes(group)) {
        seen.add(route.id);
        out.push(route);
      }
    }
  }
  // Keep routes removed from the catalogue visible so users can delete their secrets.
  for (const route of credentialStore.listCredentialRoutes()) {
    if (!seen.has(route.id)) out.push(route);
  }
  return out;
}

function requireMode(serviceId: string, billingMode: string): {
  service: ServiceDef;
  mode: BillingModeDef;
  billingMode: CredentialBillingMode;
} {
  const service = getService(serviceId);
  if (!service) throw new ServiceError(400, `Unknown service: ${serviceId}`);
  if (billingMode !== "sub" && billingMode !== "key") {
    throw new ServiceError(400, `Billing mode must be "sub" or "key"`);
  }
  const mode = getMode(serviceId, billingMode);
  if (!mode) throw new ServiceError(400, `${service.name} has no ${billingMode} billing mode`);
  return { service, mode, billingMode };
}

export interface CreateCredentialInput {
  serviceId: string;
  billingMode: string;
  secret: string;
  label?: string;
}

export function createStringCredential(
  credentialStore: CredentialStore,
  input: CreateCredentialInput,
): { route: CredentialRoute; routes: CredentialRoute[] } {
  const { service, billingMode } = requireMode(input.serviceId, input.billingMode);
  if (!modeCredentialFor(service.id, billingMode, "string")) {
    throw new ServiceError(
      400,
      `${service.name}'s ${billingMode === "sub" ? "subscription" : "API key"} is not authenticated by a supplied secret`,
    );
  }
  const secret = typeof input.secret === "string" ? input.secret.trim() : "";
  if (!secret) throw new ServiceError(400, "Credential cannot be empty");

  const existing = credentialStore.listCredentialRoutes(service.id, billingMode);
  const existingStrings = existing.filter((r) => r.via === "string");
  if (existingStrings.length > 0 && !modeAllowsMultipleCredentials(billingMode)) {
    throw new ServiceError(
      409,
      `${service.name} already has an API key. Edit or remove it instead — API keys do not fail over, so a second one would never be used.`,
    );
  }

  const label = normalizeLabel(input.label);
  const now = Date.now();
  const route: CredentialRoute = {
    id: `cred_${randomUUID()}`,
    serviceId: service.id,
    billingMode,
    via: "string",
    label: label ?? generatedLabel(service.name, billingMode, new Set(existing.map((r) => r.label))),
    labelIsGenerated: label === null,
    isPrimary: false,
    // Append so adding a credential does not change the current first choice.
    priority: existing.reduce((max, r) => Math.max(max, r.priority ?? -1), -1) + 1,
    // Ready means stored; validity is checked when the harness uses the secret.
    status: "ready",
    createdAt: now,
    updatedAt: now,
  };
  credentialStore.upsertCredentialRouteWithSecret(route, secret);
  syncProcessEnvForMode(credentialStore, service.id, billingMode, undefined);
  return { route, routes: listCredentialRoutes(credentialStore) };
}

// Legacy single-slot writers may replace a key; the HTTP add route must not.
export function upsertSingleStringCredential(
  credentialStore: CredentialStore,
  serviceId: string,
  billingMode: string,
  secret: string,
): CredentialRoute {
  const { billingMode: mode } = requireMode(serviceId, billingMode);
  const existing = credentialStore
    .listCredentialRoutes(serviceId, mode)
    .find((r) => r.via === "string");
  if (existing) return updateStringCredential(credentialStore, existing.id, { secret }).route;
  return createStringCredential(credentialStore, { serviceId, billingMode, secret }).route;
}

export function updateStringCredential(
  credentialStore: CredentialStore,
  routeId: string,
  patch: { label?: string; secret?: string },
): { route: CredentialRoute; routes: CredentialRoute[] } {
  const route = requireStringRoute(credentialStore, routeId);
  const before = deliveredValueFor(credentialStore, route.serviceId, route.billingMode);
  let next = route;
  if (patch.label !== undefined) {
    const label = normalizeLabel(patch.label);
    if (!label) throw new ServiceError(400, "Credential label cannot be empty");
    if (label.length > 120) throw new ServiceError(400, "Credential label is too long (max 120 characters)");
    next = { ...next, label, labelIsGenerated: false };
  }
  if (patch.secret !== undefined) {
    const secret = patch.secret.trim();
    if (!secret) throw new ServiceError(400, "Credential cannot be empty");
    credentialStore.setCredentialSecret(routeId, secret);
    next = { ...next, status: "ready" };
  }
  credentialStore.upsertCredentialRoute(next);
  syncProcessEnvForMode(credentialStore, route.serviceId, route.billingMode, before);
  return {
    route: credentialStore.getCredentialRoute(routeId) ?? next,
    routes: listCredentialRoutes(credentialStore),
  };
}


// Refresh orchestrator auth probes, but preserve deployment values that differ
// from the route's previous value. Sessions receive credentials from the store.
function syncProcessEnvForMode(
  credentialStore: CredentialStore,
  serviceId: string,
  billingMode: CredentialBillingMode,
  deliveredBefore: string | undefined,
): void {
  const envName = storageEnvFor(serviceId, billingMode);
  if (!envName) return;
  const current = process.env[envName];
  const ours = current === undefined || current === "" || current === deliveredBefore;
  if (!ours) return;
  const deliveredNow = collectServiceCredentialEnv(credentialStore)[envName];
  if (deliveredNow !== undefined) {
    process.env[envName] = deliveredNow;
    return;
  }
  if (deliveredBefore !== undefined && current === deliveredBefore) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by a catalogue storageEnv name
    delete process.env[envName];
  }
}

function deliveredValueFor(
  credentialStore: CredentialStore,
  serviceId: string,
  billingMode: CredentialBillingMode,
): string | undefined {
  const envName = storageEnvFor(serviceId, billingMode);
  return envName ? collectServiceCredentialEnv(credentialStore)[envName] : undefined;
}

// Deletion retires resident processes; refuse while one still has work on this route.
export function deleteCredentialRoute(
  credentialStore: CredentialStore,
  routeId: string,
  runnerRegistry?: Pick<SessionRunnerRegistry, "ids" | "get">,
): { routes: CredentialRoute[] } {
  const route = requireStringRoute(credentialStore, routeId);
  const busy = runnerRegistry
    ? runnerRegistry.ids().filter((sessionId: string) => {
        const runner = runnerRegistry.get(sessionId);
        return (
          !!runner
          && runner.residentRoute?.id === routeId
          && (runner.running || runner.backgroundWorkDescriptions.length > 0)
        );
      })
    : [];
  if (busy.length > 0) {
    const named = busy.slice(0, 3).map((id: string) => `"${id}"`).join(", ");
    const rest = busy.length - Math.min(busy.length, 3);
    throw new ServiceError(
      409,
      `Cannot remove this credential while sessions are still working on it: ${named}${rest > 0 ? ` and ${rest} more` : ""}. `
        + "Wait for them to finish or stop them, then remove it.",
    );
  }
  const before = deliveredValueFor(credentialStore, route.serviceId, route.billingMode);
  // Remember adopted-variable removal so the next boot cannot import it again.
  const envName = storageEnvFor(route.serviceId, route.billingMode);
  const adopted = envName !== undefined && routeId === envRouteIdFor(envName);
  if (envName && adopted) {
    credentialStore.setAdoptedEnvCredential(envName, { removed: true });
    if (process.env[envName] !== undefined) {
      // Revoke immediately even if the environment no longer matches the stored value.
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by a catalogue storageEnv name
      delete process.env[envName];
    }
  }
  // Delete after the removal marker: a failed write should leave a visible row,
  // not an unrecorded removal that boot can undo.
  credentialStore.deleteCredentialRoute(routeId);
  syncProcessEnvForMode(credentialStore, route.serviceId, route.billingMode, before);
  return { routes: listCredentialRoutes(credentialStore) };
}

export function reorderCredentialRoutes(
  credentialStore: CredentialStore,
  serviceId: string,
  billingMode: string,
  routeIds: unknown,
): { routes: CredentialRoute[] } {
  const { billingMode: mode } = requireMode(serviceId, billingMode);
  if (!Array.isArray(routeIds) || routeIds.some((id) => typeof id !== "string" || !id)) {
    throw new ServiceError(400, "routeIds must be an array of credential route ids");
  }
  const ids = routeIds as string[];
  const group = credentialStore.listCredentialRoutes(serviceId, mode);
  const known = new Set(group.map((r) => r.id));
  if (new Set(ids).size !== ids.length) {
    throw new ServiceError(400, "Credential order contains duplicates");
  }
  if (ids.length !== known.size || ids.some((id) => !known.has(id))) {
    throw new ServiceError(400, "Credential order must list every credential for this service and mode exactly once");
  }
  const before = deliveredValueFor(credentialStore, serviceId, mode);
  ids.forEach((id, index) => {
    const route = group.find((r) => r.id === id)!;
    credentialStore.upsertCredentialRoute({ ...route, priority: index });
  });
  syncProcessEnvForMode(credentialStore, serviceId, mode, before);
  return { routes: listCredentialRoutes(credentialStore) };
}

function requireStringRoute(credentialStore: CredentialStore, routeId: string): CredentialRoute {
  if (typeof routeId !== "string" || !routeId.trim()) {
    throw new ServiceError(400, "Credential route id is required");
  }
  const route = credentialStore.getCredentialRoute(routeId);
  if (!route) throw new ServiceError(404, `Credential not found: ${routeId}`);
  if (route.via !== "string") {
    // Account removal also needs to stop login and remove its credential directory.
    throw new ServiceError(400, "That credential is a connected account — manage it from its service's accounts.");
  }
  return route;
}

function normalizeLabel(label: string | undefined): string | null {
  const normalized = typeof label === "string" ? label.trim() : "";
  return normalized || null;
}
