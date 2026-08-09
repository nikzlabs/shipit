/**
 * docs/252 phase 3 — **the resolver**: a selection, plus what this install has,
 * becomes the four facts a spawn needs — harness, endpoint, credential, style.
 *
 * It is a callable component rather than inline spawn code on purpose. Phase 7
 * (non-turn work: session naming, pull-request descriptions) is its second
 * caller and picks a model independently of any session, so a resolver reachable
 * only from the turn path would have to be extracted then, under a phase that
 * has no other reason to touch spawn code. Free if honoured up front.
 *
 * Three things live here and nothing else:
 *
 *  - **Eligibility inputs** — the user's configured credentials, in the shape
 *    `catalogue/index.ts` states req 8's rule over. The rule itself is in the
 *    catalogue (pure, no store); this only supplies the facts.
 *  - **Turn routing** — WHICH credential of the selected `(service, billing
 *    mode)` a turn authenticates with, replacing the per-`AgentId` question
 *    `selectAccountForTurn` used to be asked on its own.
 *  - **Spawn identity** — the whole spawn-relevant tuple the resident-process
 *    guard compares, which is a model string no longer.
 */

import type { AgentId, ServiceRouting, SessionInfo } from "../shared/types.js";
import type {
  AccountSelection,
  ProviderAccountManager,
  ProviderRoute,
} from "./provider-account-manager.js";
import type { CredentialStore } from "./credential-store.js";
import type { BillingMode, ModelSelection } from "../shared/catalogue/index.js";
import {
  SERVICES,
  type ConfiguredCredential,
  getMode,
  getService,
  harnessCanCarry,
  modeCredentialFor,
  resolveSpawnShaping,
  storageEnvFor,
} from "../shared/catalogue/index.js";
import { orderCredentialRoutes } from "../shared/types/domain-types/credential-route.js";

/** The `CredentialStore` surface this module reads. Narrow so tests can fake it. */
export type ServiceRoutingCredentialSource = Pick<
  CredentialStore,
  "listCredentialRoutes" | "getCredentialSecret"
>;

/**
 * ShipIt's historical route ids for the three env-delivered credentials that
 * predate the credential store.
 *
 * These are not a special case in the routing rules — they are the *ids* a
 * session row already holds, and re-deriving a new id for the same credential
 * would orphan every pinned session written before this feature. Keyed by the
 * catalogue's `storageEnv` so the mapping is stated once against the row that
 * owns the variable, rather than per service.
 *
 * `claude-env-oauth` is the reason this is keyed on the variable and not on the
 * billing mode: it is a *subscription* delivered as an environment token, so it
 * belongs to `(anthropic, sub)` while `claude-api-key` belongs to
 * `(anthropic, key)`.
 */
const LEGACY_RESERVED_ROUTE_IDS: Record<string, string> = {
  ANTHROPIC_AUTH_TOKEN: "claude-env-oauth",
  ANTHROPIC_API_KEY: "claude-api-key",
  OPENAI_API_KEY: "codex-api-key",
};

/** The route id an environment-delivered credential of this mode is known by. */
export function envRouteIdFor(storageEnv: string): string {
  return LEGACY_RESERVED_ROUTE_IDS[storageEnv] ?? `env:${storageEnv}`;
}

/**
 * Every credential this install holds, for req 8's rule.
 *
 * Two sources, and the second is easy to forget: the credential store, plus any
 * catalogue `storageEnv` the **deployment** set in the environment itself. A
 * deployment-supplied `ANTHROPIC_API_KEY` has no row in the store — phase 2 is
 * explicit that ShipIt only ever touches a value it put there — so an
 * eligibility rule reading the store alone would report that install as having
 * no credential at all and empty its picker.
 */
export function listConfiguredCredentials(
  credentialStore: ServiceRoutingCredentialSource,
  env: NodeJS.ProcessEnv = process.env,
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
    // A `via: "string"` row with no secret behind it is a credential that
    // reports configured and delivers nothing — the exact window phase 2's
    // one-write upsert removed. Treat it as absent rather than offer a model
    // whose turn cannot authenticate.
    if (route.via === "string" && !credentialStore.getCredentialSecret(route.id)) continue;
    // An account row exists from the moment the login STARTS, and a cancelled
    // one is left `unavailable` forever. Turn routing accepts only `ready` or
    // `authenticating` (`provider-account-manager.selectAccountForTurn`), so
    // counting the rest here offers a model whose every turn is refused —
    // eligibility has to ask the same question routing does, or the picker is
    // promising something the router will not do.
    if (route.via === "account" && route.status !== "ready" && route.status !== "authenticating") {
      continue;
    }
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

/** Every `(service, mode)` that accepts a string credential, with its variable name. */
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

// ---- Turn routing ----------------------------------------------------------

export interface SelectRouteDeps {
  credentialStore: ServiceRoutingCredentialSource;
  providerAccountManager?: Pick<ProviderAccountManager, "selectAccountForTurn">;
  env?: NodeJS.ProcessEnv;
}

/**
 * The credential route a turn on `(harness, selection)` should authenticate
 * with — **scoped to the selected billing mode**, which is the whole change.
 *
 * Before this, route selection asked one question per `AgentId` and the answer
 * could belong to the wrong mode entirely: a session selecting Anthropic's
 * subscription landed on `claude-api-key` whenever no account was connected,
 * so an included turn quietly became a metered one. That is the silent shift
 * onto metered billing req 12 refuses, arriving through the routing path
 * instead of through failover.
 *
 * The account walk is unchanged and still `ProviderAccountManager`'s: quota
 * tiers, cutoffs, exclusions and the `all_exhausted` verdict are docs/150's
 * machinery and this does not reimplement them. What it does is decide whether
 * that walk is the right question at all, and supply the string-delivered
 * answer when it is not.
 *
 * Returns `null` when the selection names nothing runnable, which the caller
 * treats as "pin nothing" — the pre-feature behaviour for a session that has no
 * selection yet.
 */
export function selectRouteForSelection(
  harnessId: AgentId,
  selection: ModelSelection | undefined,
  deps: SelectRouteDeps,
): AccountSelection {
  const mode = selection ? getMode(selection.serviceId, selection.billingMode) : undefined;
  if (!selection || !mode) {
    // No selection to scope by. Keep the pre-feature question so a session that
    // has never had a model picked still routes exactly as it did.
    return (
      deps.providerAccountManager?.selectAccountForTurn(harnessId)
      ?? { ok: false, reason: "auth_required" }
    );
  }

  const acceptsAccount =
    modeCredentialFor(selection.serviceId, selection.billingMode, "account") !== undefined
    && harnessCanCarry(harnessId, { ...selection, via: "account" });

  if (acceptsAccount && deps.providerAccountManager) {
    const selected = deps.providerAccountManager.selectAccountForTurn(harnessId);
    // Its answer is taken only when it names an ACCOUNT. Its own trailing
    // env/key fallback is mode-blind — it is what would hand an `anthropic:sub`
    // selection the metered `claude-api-key` — so the env-delivered case is
    // resolved below, against THIS mode's own variable.
    if (selected.ok && selected.route.kind === "account") return selected;
    // `all_exhausted` is returned unchanged rather than falling through to this
    // mode's env-delivered credential. Every connected subscription being spent
    // is exactly the state req 12 says to stop on, and today's behaviour already
    // stops there; widening it to a same-mode string credential is a failover
    // decision and belongs to phase 5, which owns that policy end to end.
    if (!selected.ok && selected.reason === "all_exhausted") return selected;
  }

  const route = stringRouteFor(harnessId, selection, deps);
  return route ? { ok: true, route } : { ok: false, reason: "auth_required" };
}

/**
 * The string-delivered credential of this `(service, mode)`, as a route.
 *
 * Stored routes first, in the user's own order, then the deployment's
 * environment. Choosing *among* several stored credentials of one mode is req
 * 12's failover and belongs to phase 5; taking the first in order is what
 * delivery already does, so the turn authenticates with the credential the
 * worker was actually handed rather than a different one.
 */
function stringRouteFor(
  harnessId: AgentId,
  selection: ModelSelection,
  deps: SelectRouteDeps,
): ProviderRoute | null {
  if (!harnessCanCarry(harnessId, { ...selection, via: "string" })) return null;
  const stored = orderCredentialRoutes(
    deps.credentialStore
      .listCredentialRoutes(selection.serviceId, selection.billingMode)
      .filter((route) => route.via === "string" && deps.credentialStore.getCredentialSecret(route.id)),
  );
  const first = stored[0];
  if (first) return { kind: "reserved", id: first.id };
  const storageEnv = storageEnvFor(selection.serviceId, selection.billingMode);
  const fromEnv = storageEnv ? (deps.env ?? process.env)[storageEnv] : undefined;
  if (storageEnv && typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return { kind: "reserved", id: envRouteIdFor(storageEnv) };
  }
  return null;
}

// ---- Spawn shaping ---------------------------------------------------------

/**
 * The `ServiceRouting` a turn carries to the worker, or `undefined` when there
 * is nothing to shape.
 *
 * **Nothing to shape is the common case and must stay a true no-op**: a session
 * on the harness's own vendor through a login account keeps today's spawn
 * exactly — the CLI's own endpoint, its own credential root, no environment
 * rewriting. Shaping an account-delivered credential would break it outright,
 * because a `scoped-home` credential IS the vendor's login and its token
 * exchange is bound to that vendor's endpoint.
 *
 * So the rule keys on **delivery**: a string-delivered credential is
 * materialized into the harness's variable and the endpoint is set alongside
 * it; an account-delivered one is left to the existing scoped-home path.
 */
export function serviceRoutingForSelection(
  harnessId: AgentId,
  selection: ModelSelection | undefined,
  route: ProviderRoute | null | undefined,
): ServiceRouting | undefined {
  if (!selection) return undefined;
  if (route?.kind === "account") return undefined;
  // A mode that can be account-delivered, with no route resolved yet, is not
  // something to shape on a guess. The pinned route is the evidence, and env
  // prep pins it before the run params are built — so an absent one here means
  // the router is not wired at all (a test, local mode), where the pre-feature
  // spawn is the right answer. A mode that accepts ONLY strings has no such
  // ambiguity and shapes regardless, which is what makes a custom service work
  // on a session that has never pinned a route.
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
    credentialSourceEnv: shaping.credential.sourceEnv,
    credentialTarget: shaping.credential.target,
  };
}

// ---- Spawn identity (the resident-process boundary) ------------------------

/**
 * Everything about a session that decides what a CLI process was spawned AS.
 *
 * The resident-process guard used to compare two model *strings*, which is
 * sound only while a model id identifies a service. It does not (req 5): the
 * same `deepseek-v4-flash` is reachable direct and through a gateway, so a
 * switch between them left the strings equal, fired no kill, and ran the next
 * turn on the old process — old endpoint, old credential, wrong account billed
 * (req 11). Phase 3 is the phase that first makes that switch reachable, so it
 * is the phase that has to widen this.
 *
 * Derived from the SESSION ROW at both ends — the guard's question and the
 * stamp taken at spawn — rather than from the built run params at one end and
 * the session at the other. Two derivations of "the same" tuple is how a
 * spurious respawn on every turn gets built.
 */
/**
 * The identity the NEXT spawn of this session would have — what the resident
 * guard compares against `runner.appliedSpawnIdentity`.
 *
 * `undefined` for a session the manager does not know, which the guard reads as
 * "no opinion" and leaves the resident process alone. That is the same answer a
 * missing model gave before, and the safe one: a spurious kill costs a respawn
 * on every turn.
 */
export function desiredSpawnIdentity(
  sessionManager: { get(id: string): SessionInfo | undefined },
  sessionId: string,
  harnessId: AgentId,
): string | undefined {
  const session = sessionManager.get(sessionId);
  return session ? sessionSpawnIdentity(session, harnessId) : undefined;
}

export function sessionSpawnIdentity(
  session: Pick<
    SessionInfo,
    "model" | "serviceId" | "billingMode" | "providerRouteKind" | "providerRouteId"
  >,
  harnessId: AgentId,
): string {
  const selection =
    session.serviceId && session.billingMode && session.model
      ? { serviceId: session.serviceId, billingMode: session.billingMode, modelId: session.model }
      : undefined;
  const shaping = selection ? resolveSpawnShaping(harnessId, selection) : undefined;
  return [
    harnessId,
    session.serviceId ?? "-",
    session.billingMode ?? "-",
    session.model ?? "-",
    shaping?.style ?? "-",
    shaping?.endpoint.url ?? "-",
    session.providerRouteKind && session.providerRouteId
      ? `${session.providerRouteKind}:${session.providerRouteId}`
      : "-",
  ].join("|");
}
