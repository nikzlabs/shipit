/**
 * docs/252 phase 2 — the credential a user supplies for a `(service, billing
 * mode)`, and nothing else.
 *
 * What this owns is **string-delivered** credentials: an API key, or a
 * subscription authenticated by one (GLM's coding plan). Account-backed
 * subscriptions still go through the docs/150 flow in `provider-accounts.ts` —
 * they need a login, a credential root and a refresh, none of which a pasted
 * secret has — so "add a credential" has two implementations and one screen.
 *
 * Three rules the catalogue decides and this module enforces, rather than the
 * UI:
 *
 *   - a mode must exist and must **accept** a string credential. Anthropic's
 *     subscription accepts one (`claude-env-oauth`), OpenAI's does not;
 *   - a **key** mode holds exactly one credential. Req 12 says keys never fail
 *     over, so a second key is storage no routing rule can ever reach. A
 *     **subscription** holds as many as the user has — that is what req 12
 *     fails over between;
 *   - the secret never comes back out. `CredentialRoute` carries none by
 *     construction, so there is no redaction boundary to get wrong.
 *
 * Phase 2 boundary: nothing here routes a turn. A stored key is delivered to
 * the session container (`session-agent-env.ts`) and used by nothing until
 * phase 3 shapes spawns from the selected model's service.
 */

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
import { ServiceError } from "./types.js";
import type { SessionRunnerRegistry } from "../session-runner.js";

/** The label ShipIt gives a credential the user did not name. */
function generatedLabel(serviceName: string, billingMode: CredentialBillingMode, taken: Set<string>): string {
  const base = billingMode === "sub" ? `${serviceName} plan` : `${serviceName} key`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Every stored credential, grouped by `(service, billing mode)` and in
 * selection order within each group, with `isPrimary` derived from position.
 *
 * Groups are emitted in **catalogue order**, which is the same order the picker
 * and req 9's derived default walk — so "first configured service" means the
 * same thing everywhere rather than depending on what the user happened to add
 * first.
 */
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
  // A route whose service or mode has left the catalogue still exists on disk
  // and still holds a secret. Emitting it — rather than silently hiding it — is
  // what lets the user delete it; a hidden credential the user cannot see is
  // one they cannot revoke.
  for (const route of credentialStore.listCredentialRoutes()) {
    if (!seen.has(route.id)) out.push(route);
  }
  return out;
}

/**
 * Resolve and validate a `(service, billing mode)` pair, returning the
 * catalogue rows behind it.
 */
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

/**
 * Store a string-delivered credential for a `(service, billing mode)`.
 *
 * Appends to the group's order rather than inserting, for the same reason
 * connecting an account does (docs/150 req 2): adding a credential must never
 * silently change which one existing work runs on.
 */
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
    // Not a silent replace: overwriting the key a running session authenticates
    // with, because the user pressed "Add" instead of "Edit", is the single-slot
    // failure this design exists to remove — just one level up.
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
    priority: existing.reduce((max, r) => Math.max(max, r.priority ?? -1), -1) + 1,
    // A pasted secret is usable the moment it is stored — there is no login to
    // complete and nothing to verify against without spending a turn on it. Req
    // 1 is best-effort: a bad key is the harness's error to raise, not a state
    // ShipIt predicts.
    status: "ready",
    createdAt: now,
    updatedAt: now,
  };
  credentialStore.upsertCredentialRouteWithSecret(route, secret);
  syncProcessEnvForMode(credentialStore, service.id, billingMode, undefined);
  return { route, routes: listCredentialRoutes(credentialStore) };
}

/**
 * Set the single credential of a mode, creating or replacing it.
 *
 * The verb the legacy single-slot writers need — "here is the key, make that be
 * the key" — expressed once so they cannot each invent their own. Deliberately
 * not exposed as an HTTP route: the Services surface distinguishes adding from
 * editing, which is what stops an "Add" click silently replacing a working
 * credential, and this bypasses that on purpose for callers that never had the
 * distinction.
 */
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

/**
 * Rename a credential, replace its secret, or both. An absent field is left
 * unchanged; an empty secret is a rejection rather than a clear, because
 * "remove the credential" is {@link deleteCredentialRoute} and conflating the
 * two makes a stray empty form field revoke a working key.
 */
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
    // Once the user names it, nothing regenerates the label over the top.
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


/**
 * Keep the orchestrator's own `process.env` in step with what a mode now
 * delivers.
 *
 * Load-bearing, and easy to miss because it is not delivery to the *session*:
 * `reservedRouteFor` and `AgentRegistry.isAuthConfigured` answer from
 * `process.env`, and `app-di` seeds it from the stored routes at boot. Without
 * this, removing a key would stop delivering it to every session and leave the
 * orchestrator still reporting the provider as authenticated until a restart —
 * a credential the user revoked, still counted.
 *
 * **Only ever touches a value this process put there**, which is the half a
 * first cut got wrong. Boot seeding deliberately skips a name that is already
 * set (`app-di.ts`), so a variable the *deployment* supplied is not ours: an
 * unconditional write would overwrite it, and the matching clear would then
 * delete it, leaving the deployment unauthenticated until a restart. So a write
 * happens only into an absent/empty slot or over our own previous value, and a
 * clear only over our own previous value.
 *
 * Nothing is lost by leaving a deployment value in place: these probes ask
 * whether a credential is *present*, never which one. Which credential a session
 * actually receives comes from the route store
 * ({@link collectServiceCredentialEnv}), not from here.
 *
 * Phase 3 should retire this along with the env probes it exists to feed.
 */
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

/** What a mode delivers right now, for {@link syncProcessEnvForMode}'s before/after comparison. */
function deliveredValueFor(
  credentialStore: CredentialStore,
  serviceId: string,
  billingMode: CredentialBillingMode,
): string | undefined {
  const envName = storageEnvFor(serviceId, billingMode);
  return envName ? collectServiceCredentialEnv(credentialStore)[envName] : undefined;
}

/**
 * Remove a stored credential and its secret.
 *
 * docs/260 req 13 — refused while a live process is RUNNING a turn or holds
 * background work on this credential (`runner.residentRoute` names it): the
 * deletion's change-release would otherwise kill exactly the work req 13
 * protects. An idle resident is fine — the release after this call retires it
 * and the next turn re-routes. `runnerRegistry` is optional so callers with no
 * registry (tests, non-turn wiring) keep the unguarded behavior.
 */
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
  credentialStore.deleteCredentialRoute(routeId);
  syncProcessEnvForMode(credentialStore, route.serviceId, route.billingMode, before);
  return { routes: listCredentialRoutes(credentialStore) };
}

/**
 * Persist the fallback order within one subscription group (docs/150 req 2).
 *
 * Takes the complete set rather than a move-one verb: an ordering is only
 * meaningful as a whole, and requiring every id makes a stale client — one
 * whose list predates a credential added in another tab — fail loudly instead
 * of silently dropping that credential to the end.
 */
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
  // Reordering changes which credential is delivered first, so it changes what
  // the environment holds — the same fact the delivery test pins.
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
    // An account-backed credential is owned by the docs/150 flow, which also has
    // to end an in-flight login and remove a credential root. Editing one from
    // here would leave that state behind.
    throw new ServiceError(400, "That credential is a connected account — manage it from its service's accounts.");
  }
  return route;
}

function normalizeLabel(label: string | undefined): string | null {
  const normalized = typeof label === "string" ? label.trim() : "";
  return normalized || null;
}
