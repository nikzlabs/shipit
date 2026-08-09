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
import type { CredentialRoute } from "../shared/types/domain-types/credential-route.js";
import {
  credentialRouteEnvName,
  isStoredCredentialRouteId,
  orderCredentialRoutes,
} from "../shared/types/domain-types/credential-route.js";
import type { AccountSelectionMode } from "../shared/types/domain-types/provider.js";

/** The `CredentialStore` surface this module reads. Narrow so tests can fake it. */
export type ServiceRoutingCredentialSource = Pick<
  CredentialStore,
  "listCredentialRoutes" | "getCredentialSecret" | "getSelectionMode"
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
 * docs/252 req 10 — which `(service, billing mode)` a **route id** belongs to.
 *
 * The inverse of {@link envRouteIdFor}, plus the credential store for stored
 * routes. Quota is reported per billing mode of a service, so the one thing a
 * quota snapshot needs is the mode that owns the credential the reporting turn
 * ran on — and that is a property of the route, never of the harness that
 * happened to report it. A harness redirected to another service must not file
 * that service's usage against its own vendor's quota.
 *
 * `undefined` for a route this cannot classify, which callers treat as "we
 * cannot say whose quota this is" and drop rather than guess.
 */
export function credentialOwnerForRouteId(
  routeId: string,
  credentialStore: Pick<CredentialStore, "getCredentialRoute">,
): { serviceId: string; billingMode: BillingMode } | undefined {
  const stored = credentialStore.getCredentialRoute(routeId);
  if (stored) return { serviceId: stored.serviceId, billingMode: stored.billingMode };
  // A deployment-supplied credential has no stored row — phase 2 only ever
  // touches values this process put there — so its reserved id is resolved
  // from the catalogue instead.
  for (const service of servicesWithStringCredentials()) {
    if (envRouteIdFor(service.storageEnv) === routeId) {
      return { serviceId: service.serviceId, billingMode: service.billingMode };
    }
  }
  return undefined;
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
  /** Injected clock, so a benched-credential test does not have to wait one out. */
  now?: () => number;
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
    // mode's env-delivered credential. **Phase 5 owns this decision and has
    // taken it: no fall-through.** Every connected subscription being spent is
    // exactly the state req 12 says to stop on, and the env-delivered token is
    // not evidence of a subscription that is still good — it carries no row, so
    // ShipIt tracks no quota for it and could neither bench it after it failed
    // nor tell the user which credential the turn ended up on. Rolling onto it
    // would replace req 13's "the earliest window resets at X" with a second
    // failure and a worse message. Reaching a same-mode string credential from a
    // spent account set is a hop ShipIt cannot see the far side of, so it does
    // not make it.
    if (!selected.ok && selected.reason === "all_exhausted") return selected;
  }

  return stringSelectionFor(harnessId, selection, deps);
}

/**
 * The string-delivered credential of this `(service, mode)` a turn should
 * authenticate with — **and, for a subscription, which of them** (docs/252
 * phase 5, req 12).
 *
 * Phase 2 made a subscription able to hold several string credentials and phase
 * 3 delivered the first in order, which is where it stopped: a second GLM key
 * was stored and unreachable. This is the walk that makes it reachable, and it
 * is deliberately the same shape as `ProviderAccountManager.selectAccountForTurn`
 * rather than a second policy:
 *
 *   - **`sub`** — skip credentials benched by {@link
 *     CredentialStore.markCredentialRouteExhausted}, in the user's own order
 *     (or least-recently-used under `balanced`). When every stored credential is
 *     benched the answer is `all_exhausted` with the earliest reset, which is
 *     req 12's "no subscription left to fail over to: stop and say so".
 *   - **`key`** — the first in order, always. A key has no window to exhaust and
 *     never fails over, so it never asks which of them is healthy — and the one
 *     it names has to be the one delivery hands the worker, or the turn would be
 *     attributed to a credential it did not authenticate with.
 *
 * The deployment's environment is the last resort **only when nothing is
 * stored**, which is exactly what phase 3 did. It is not a failover target: it
 * carries no row, so it can be neither benched nor ordered, and rolling onto it
 * because the stored credentials are spent would be a hop ShipIt could never
 * undo or explain.
 */
function stringSelectionFor(
  harnessId: AgentId,
  selection: ModelSelection,
  deps: SelectRouteDeps,
): AccountSelection {
  if (!harnessCanCarry(harnessId, { ...selection, via: "string" })) {
    return { ok: false, reason: "auth_required" };
  }
  const stored = deps.credentialStore
    .listCredentialRoutes(selection.serviceId, selection.billingMode)
    .filter((route) => route.via === "string" && deps.credentialStore.getCredentialSecret(route.id));

  if (stored.length > 0) {
    if (selection.billingMode !== "sub") {
      return { ok: true, route: { kind: "reserved", id: orderCredentialRoutes(stored)[0].id } };
    }
    const now = deps.now?.() ?? Date.now();
    const ordered = orderStringCredentials(
      stored,
      deps.credentialStore.getSelectionMode(selection.serviceId, selection.billingMode),
    );
    const next = ordered.find((route) => !isBenched(route.exhaustedUntil, now));
    if (next) return { ok: true, route: { kind: "reserved", id: next.id } };
    const benched = stored
      .map((route) => route.exhaustedUntil)
      .filter((until): until is number => typeof until === "number" && until > now);
    return {
      ok: false,
      reason: "all_exhausted",
      earliestResetAt: benched.length > 0 ? new Date(Math.min(...benched)).toISOString() : null,
    };
  }

  const storageEnv = storageEnvFor(selection.serviceId, selection.billingMode);
  const fromEnv = storageEnv ? (deps.env ?? process.env)[storageEnv] : undefined;
  if (storageEnv && typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return { ok: true, route: { kind: "reserved", id: envRouteIdFor(storageEnv) } };
  }
  return { ok: false, reason: "auth_required" };
}

function isBenched(exhaustedUntil: number | null | undefined, now: number): boolean {
  return typeof exhaustedUntil === "number" && exhaustedUntil > now;
}

/**
 * The user's fallback order, or least-recently-used under `balanced` — the
 * string-credential twin of `orderForSelectionMode`, and the reason phase 2's
 * *Use in order / Spread across accounts* control now does something for a
 * string-delivered subscription.
 */
function orderStringCredentials(
  routes: readonly CredentialRoute[],
  mode: AccountSelectionMode,
): CredentialRoute[] {
  const ordered = orderCredentialRoutes(routes);
  if (mode !== "balanced") return ordered;
  return [...ordered].sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
}

/**
 * Stamp the credential a turn resolved onto, so `balanced` has something to
 * sort by. A no-op for an account route (docs/150's `markAccountUsed` owns
 * those) and for an env-delivered one, which has no row to stamp.
 */
export function markCredentialRouteUsed(
  credentialStore: Pick<CredentialStore, "markCredentialRouteUsed">,
  route: ProviderRoute | undefined,
): void {
  if (route?.kind !== "reserved") return;
  credentialStore.markCredentialRouteUsed(route.id);
}

/**
 * docs/252 phase 5 — is the credential this session is **already pinned to** no
 * longer able to run a turn?
 *
 * The string-delivered twin of `sessionNeedsAccountFailover`, and it answers
 * only about subscriptions: a `key` route is never benched (req 12), and an
 * env-delivered credential has no row, so neither can report unusable here. A
 * pinned row that has been *deleted* is handled separately at env prep — that is
 * a removal, not an exhaustion, and it re-pins rather than failing over.
 */
export function sessionNeedsCredentialFailover(
  session:
    | Pick<SessionInfo, "providerRouteKind" | "providerRouteId">
    | undefined,
  credentialStore: Pick<CredentialStore, "getCredentialRoute"> | undefined,
  now: number = Date.now(),
): boolean {
  if (!session || !credentialStore) return false;
  if (session.providerRouteKind !== "reserved" || !session.providerRouteId) return false;
  const route = credentialStore.getCredentialRoute(session.providerRouteId);
  if (route?.billingMode !== "sub") return false;
  return isBenched(route.exhaustedUntil, now);
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
    // docs/252 phase 5 — read the PINNED credential's own variable when the turn
    // is pinned to a stored one. The catalogue's `storageEnv` names the group,
    // and delivery puts the group's first credential there; once req 12's
    // failover can move a session onto the second, sourcing from the group name
    // would authenticate with the credential ShipIt had just benched while
    // attributing the turn to the one it moved to. An env-delivered credential
    // has no row and no id, so it keeps the group name — which is the only name
    // it has ever had.
    credentialSourceEnv:
      route?.kind === "reserved" && isStoredCredentialRouteId(route.id)
        ? credentialRouteEnvName(route.id)
        : shaping.credential.sourceEnv,
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
