/**
 * Egress decision API route (docs/172 Gap 1, planning#92 — Tier C allow-once).
 *
 * Surface:
 *   GET /api/egress/decision?host=<sni>&session=<sessionId>
 *
 * The Tier C SNI proxy queries this for a host not in its static allowlist (its
 * `EGRESS_PROXY_DECISION_URL`). The orchestrator is the policy decision point:
 * it answers `{ allow }` from the per-session allow-once policy, and on a denied
 * host that hasn't been carded yet it emits the inline allow-once card for the
 * user. Deny-fast: the proxy resets the connection immediately on `allow:false`;
 * the agent retries, and once the user approves the next query returns `allow:true`.
 *
 * `containerAccessible: true` — the proxy reaches it from the agent's netns
 * (bridge). The endpoint is query-only: it can trigger a card and read a
 * decision, but it cannot GRANT anything (granting is the browser-only
 * `egress_decision` WS path), so an agent that calls it directly can at most
 * propose a card it can't approve.
 *
 * planning#371 — that flag covers the AGENT container only. A Compose service's
 * proxy asks the same question from the service's own network namespace, and
 * every Compose-service IP is now denied the whole `/api/*` surface
 * (`api-container-guard.ts` §0.5) precisely because the service and its proxy
 * are indistinguishable by address. That query is admitted instead by the token
 * the sidecar was launched with (`egress-decision-auth.ts`), which is why the
 * route needs no per-caller change here: the guard decides who reaches it, and
 * the answer is unchanged for everyone it still admits.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { emitChatCard } from "./chat-card-persistence.js";
import { isEgressHostAllowed, shouldCardEgressHost } from "./egress-policy.js";
import {
  normalizeHost,
  buildEffectiveAllowlist,
  isBuiltinDefault,
} from "./egress-allowlist.js";
import { egressHostReach } from "./egress-host-reach.js";
import { EGRESS_GLOBAL_SCOPE } from "./egress-allowlist-store.js";
import type { EgressAllowlistStore } from "./egress-allowlist-store.js";
import type { CredentialStore } from "./credential-store.js";
import type {
  EgressSettings,
  EgressSessionSettings,
  EgressAllowlistView,
  EgressHostGrantOutcome,
  EgressHostReach,
  EgressEnforcementStatus,
} from "../shared/types.js";
import { computeEgressGrantOutcome } from "./egress-grant-outcome.js";
import { emitSessionSettingsChangeCard } from "./services/session-settings.js";
import type { PersistedEgressPrompt } from "./chat-history.js";

/**
 * docs/279 — the containment override in the words the Session settings dialog
 * uses for it, for the transcript card. Snapshotted into the row, so relabelling
 * the options later cannot rewrite what an old card says the user chose.
 */
function egressModeLabel(override: boolean | null | undefined): string {
  if (override === true) return "Contained";
  if (override === false) return "Open";
  return "Inherit global";
}

/** Stable per (session, host) so a re-denied host updates one card, never duplicates. */
export function egressCardId(sessionId: string, host: string): string {
  return `egress-${sessionId}-${normalizeHost(host)}`;
}

/**
 * docs/285 — one enforcement value flows through this file, and the boolean is
 * DERIVED from it at each edge rather than carried alongside. Threading both
 * would let a call site pass a mismatched pair, and the two disagreeing is
 * precisely the failure the status field was added to end.
 */
function enforcementFields(status: EgressEnforcementStatus): {
  enforcementActive: boolean;
  enforcementStatus: EgressEnforcementStatus;
} {
  return { enforcementActive: status === "active", enforcementStatus: status };
}

/** Snapshot the global egress settings (toggle + user allowlist + enforcement). */
function globalSettings(
  store: EgressAllowlistStore,
  enforcement: EgressEnforcementStatus,
): EgressSettings {
  return {
    globalEnabled: store.getGlobalEnabled(),
    globalHosts: store.listHosts(EGRESS_GLOBAL_SCOPE),
    ...enforcementFields(enforcement),
  };
}

/**
 * Snapshot a session's egress view (override + per-session hosts + resolution).
 *
 * `startedContained` is the containment the session's LIVE container was created
 * with (`null` when none is running); the view exposes it plus a `pendingRestart`
 * flag — true when the now-resolved containment differs — so the client can show
 * "pending · restart to apply" without re-deriving the live topology (docs/172).
 */
function sessionSettings(
  store: EgressAllowlistStore,
  sessionId: string,
  enforcement: EgressEnforcementStatus,
  startedContained: boolean | null,
): EgressSessionSettings {
  const effectiveContained = store.resolveContained(sessionId);
  return {
    sessionId,
    override: store.getSessionOverride(sessionId),
    hosts: store.listHosts(sessionId),
    effectiveContained,
    globalEnabled: store.getGlobalEnabled(),
    ...enforcementFields(enforcement),
    startedContained,
    pendingRestart: startedContained !== null && startedContained !== effectiveContained,
  };
}

/**
 * Build the effective-allowlist view (every reachable host + provenance) for the
 * Settings editor. When `sessionId` is given, the view includes that session's
 * per-session extras + override/resolution; otherwise it's the global-only view.
 */
function allowlistView(
  store: EgressAllowlistStore,
  credentialStore: CredentialStore | undefined,
  sessionId: string | undefined,
  enforcement: EgressEnforcementStatus,
  startedContained: boolean | null,
): EgressAllowlistView {
  const entries = buildEffectiveAllowlist({
    credentialStore,
    globalHosts: store.listHosts(EGRESS_GLOBAL_SCOPE),
    sessionHosts: sessionId ? store.listHosts(sessionId) : [],
    suppressedDefaults: store.listSuppressedDefaults(),
  });
  return {
    entries,
    globalEnabled: store.getGlobalEnabled(),
    ...enforcementFields(enforcement),
    session: sessionId ? sessionSettings(store, sessionId, enforcement, startedContained) : null,
    defaultsCustomized: store.hasSuppressedDefaults(),
  };
}

/**
 * docs/285 — serialize a session's network-mode writes against each other.
 *
 * The write now rebuilds the container, and `restartContainer` has no guard of
 * its own: two concurrent calls for one session would interleave a destroy and a
 * create against each other. Two tabs on one session, or the composer and the
 * Session settings dialog, can each issue a PUT — the client's save barrier
 * orders one surface's writes, not two clients'.
 *
 * Deliberately the smallest possible lock: this route with itself, per session.
 * It is not the cross-subsystem admission section an earlier revision of this
 * feature carried — that one spanned the Send path and had to be reasoned about
 * against dispatch, graduation and the reuse path. Nothing outside this handler
 * takes this one, so it cannot deadlock against anything and cannot make a
 * session read as busy.
 */
const networkModeWrites = new Map<string, Promise<unknown>>();

function serializeNetworkModeWrite<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = networkModeWrites.get(sessionId) ?? Promise.resolve();
  // eslint-disable-next-line no-restricted-syntax -- Promise two-arg form: run `fn` whether or not the predecessor settled cleanly
  const run = previous.then(fn, fn);
  // eslint-disable-next-line no-restricted-syntax -- Promise two-arg form: the chain tail must settle cleanly on both outcomes
  const tail = run.then(() => {}, () => {});
  networkModeWrites.set(sessionId, tail);
  // eslint-disable-next-line no-restricted-syntax -- fire-and-forget cleanup in a sync function
  void tail.then(() => {
    // Only the CURRENT tail may clear the entry; a later writer has replaced it.
    if (networkModeWrites.get(sessionId) === tail) networkModeWrites.delete(sessionId);
  });
  return run;
}

export async function registerEgressRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const store = deps.egressAllowlistStore;
  // Whether this deployment can actually ENFORCE containment (enforcement on +
  // sidecar image configured). Resolved once at registration — it's a fixed
  // function of the process env. The honest signal the browser uses to
  // distinguish containment policy from enforcement (docs/172, planning#92).
  // docs/285 — the same fact with the reason kept. `enforcementActive` stays as
  // the predicate the reach/policy logic below already asks; `enforcement` is
  // what the settings views report, so the UI can name the case. Derived from
  // the boolean when a caller supplies only that — which can never produce
  // `disabled`, hence the explicit status in production.
  const enforcement: EgressEnforcementStatus =
    deps.egressEnforcementStatus ?? (deps.egressEnforcementActive ? "active" : "no-sidecar");
  const enforcementActive = enforcement === "active";
  // planning#383 — whether Tier B exists on this deployment at all. Resolved
  // once here for the same reason: a fixed function of the process env.
  const dnsControlDeployed = deps.egressDnsControlDeployed;

  // The containment a session's LIVE container was actually started with — the
  // source of truth for "pending · restart to apply" (docs/172). `null` when no
  // running container exists (nothing plumbed to diff against, nothing to
  // restart). Reads the in-memory container record (the egress sidecars are a
  // creation-time topology choice recorded there), never the agent's netns, so
  // this stays on the browser-only surface (planning#131).
  const liveContained = (sessionId: string): boolean | null => {
    const sc = deps.containerManager?.get(sessionId);
    if (sc?.status !== "running") return null;
    return sc.egressContainedAtStart ?? null;
  };

  // planning#376/#380/#383 — can this host be made reachable at all, and by
  // whom? ONE predicate answers it for every host surface (`egress-host-reach.ts`),
  // so what the Plugins card said before the click and what this route reports
  // after it cannot disagree. This used to be a local re-derivation of the
  // proxy's composition, which is how the three defects each got one case right
  // and the next one wrong.
  //
  // The containment asked about is `isEgressContained`'s own rule — what the
  // LIVE container started with, else the resolved policy, else the deployment's
  // enforcement — because that is the rule the Plugins card asks, and the two
  // stating different things about one host is the whole defect class. (Review
  // finding: reading the policy alone reported "reaches nothing" for a session
  // whose running container started Open and is unrestricted right now, while
  // the card said `allowed` about the same host.) Fails to `grantable` when
  // nothing is knowable — an unwired resolver must not be rendered as a
  // positive claim that no grant can work.
  //
  // The app-wide Settings editor has NO session, and that is not a special case
  // either: the same predicate answers it with no config at all, so a
  // deployment-wide fact still lands (`blocked-by-deployment`) while a host the
  // Tier A floor admits does not get swept up with it.
  const reachFor = (sessionId: string | null, host: string): EgressHostReach => {
    const config = sessionId ? deps.containerManager?.resolveEgress(sessionId) : undefined;
    const startedContained = sessionId ? liveContained(sessionId) : null;
    return egressHostReach({
      contained: startedContained ?? config?.contained ?? enforcementActive,
      dnsControlDeployed,
      config,
      ...(sessionId ? { sessionId } : {}),
    })(host);
  };

  // ---- Browser-only egress settings (docs/172, planning#92) ------------------
  // NO `containerAccessible` flag: planning#131's default-deny keeps the contained
  // agent from reaching these to loosen its own containment. Registered only
  // when a store is wired (test setups without egress can omit it).
  if (store) {
    // Read the global containment toggle + user allowlist + enforcement state.
    app.get("/api/egress/settings", async () => globalSettings(store, enforcement));

    // The effective allowlist with provenance (built-in / operator / MCP /
    // user-added) for the Settings editor. `?session=<id>` folds in that
    // session's per-session extras + override/resolution.
    app.get<{ Querystring: { session?: string } }>(
      "/api/egress/allowlist",
      async (request) => {
        const sessionId =
          typeof request.query.session === "string" && request.query.session ? request.query.session : undefined;
        return allowlistView(store, deps.credentialStore, sessionId, enforcement, sessionId ? liveContained(sessionId) : null);
      },
    );

    // Flip the global toggle (Contained ↔ Open). Applies at the next container
    // start — egress is a creation-time choice; the client states that.
    app.put<{ Body: { globalEnabled?: boolean } }>(
      "/api/egress/settings",
      async (request) => {
        if (typeof request.body?.globalEnabled === "boolean") {
          store.setGlobalEnabled(request.body.globalEnabled);
          deps.sseBroadcast("egress_settings", globalSettings(store, enforcement));
        }
        return globalSettings(store, enforcement);
      },
    );

    // Add a host to the allowlist. scope defaults to "global" (the Settings
    // editor); a session id scopes it to one session. A global add applies at
    // the next container start; a session-scoped add to a running, contained
    // session is reloaded live (resolver DNS + ipset + proxy SNI).
    //
    // planning#376 — the response also carries `grant`: what the add actually
    // took effect on. The two scopes behave very differently and the browser
    // used to predict the difference in a button tooltip; the route ran the
    // reload (or didn't) and can see what is running, so it reports instead.
    // `session` is REPORTING-only: it names the session the outcome describes
    // for a global add, and never changes where the entry is written.
    app.post<{ Body: { host?: string; scope?: string; session?: string } }>(
      "/api/egress/hosts",
      async (request, reply) => {
        const host = typeof request.body?.host === "string" ? request.body.host.trim() : "";
        const scope = typeof request.body?.scope === "string" && request.body.scope ? request.body.scope : EGRESS_GLOBAL_SCOPE;
        if (!host) {
          reply.code(400);
          return { error: "host is required" };
        }
        const isGlobal = scope === EGRESS_GLOBAL_SCOPE;
        const reportSession = isGlobal
          ? (typeof request.body?.session === "string" && request.body.session ? request.body.session : null)
          : scope;
        // `reloaded` is `reloadEgress`'s own answer, not an assumption from the
        // scope: it declines for an unenforced deployment, an Open session, and
        // a deployment with the Tier B/C sidecars off — and in that last one the
        // agent really is left holding the old list.
        const grant = (reloaded: boolean): EgressHostGrantOutcome =>
          computeEgressGrantOutcome({
            host,
            scope: isGlobal ? "global" : "session",
            reloaded,
            sessionId: reportSession,
            enforcementActive,
            startedContained: reportSession ? liveContained(reportSession) : null,
            reach: reachFor(reportSession, host),
          });
        // Re-adding a removed built-in default just un-suppresses it (it's a
        // default, not a user entry). Otherwise it's a user-added host.
        if (scope === EGRESS_GLOBAL_SCOPE && isBuiltinDefault(host)) {
          store.unsuppressDefault(host);
        } else {
          store.addHost(scope, host);
        }
        deps.sseBroadcast("egress_settings", globalSettings(store, enforcement));
        // A per-session add can take effect immediately on a running session.
        if (!isGlobal) {
          let reloaded: boolean;
          try {
            reloaded = (await deps.containerManager?.reloadEgress(scope)) === true;
          } catch (error) {
            console.error(`[egress:${scope}] allowlist saved but live refresh failed closed:`, error);
            reply.code(503);
            return {
              error: "allowlist saved, but live service refresh failed closed",
              settings: sessionSettings(store, scope, enforcement, liveContained(scope)),
            };
          }
          return { ...sessionSettings(store, scope, enforcement, liveContained(scope)), grant: grant(reloaded) };
        }
        // A global add reloads nothing at all, by design (`plugin-egress.ts`).
        return { ...globalSettings(store, enforcement), grant: grant(false) };
      },
    );

    // Remove a host from the allowlist (durable only — tightening takes effect
    // on the next container start).
    app.delete<{ Body: { host?: string; scope?: string } }>(
      "/api/egress/hosts",
      async (request, reply) => {
        const host = typeof request.body?.host === "string" ? request.body.host.trim() : "";
        const scope = typeof request.body?.scope === "string" && request.body.scope ? request.body.scope : EGRESS_GLOBAL_SCOPE;
        if (!host) {
          reply.code(400);
          return { error: "host is required" };
        }
        // Removing a built-in default suppresses it (overridable defaults);
        // removing anything else deletes that user-added row.
        if (scope === EGRESS_GLOBAL_SCOPE && isBuiltinDefault(host)) {
          store.suppressDefault(host);
        } else {
          store.removeHost(scope, host);
        }
        deps.sseBroadcast("egress_settings", globalSettings(store, enforcement));
        return scope === EGRESS_GLOBAL_SCOPE
          ? globalSettings(store, enforcement)
          : sessionSettings(store, scope, enforcement, liveContained(scope));
      },
    );

    // Restore all built-in defaults (clear every user suppression).
    app.post("/api/egress/defaults/restore", async () => {
      store.restoreDefaults();
      deps.sseBroadcast("egress_settings", globalSettings(store, enforcement));
      return allowlistView(store, deps.credentialStore, undefined, enforcement, null);
    });

    // docs/285 — BOTH session routes below accepted an arbitrary id. The GET
    // answered with a fully-formed view for a session that does not exist
    // (`resolveContained` falls back to the global switch, so the shape is
    // plausible and entirely fictional), and the PUT persisted an override keyed
    // to nothing, which then sat in the store forever. Neither is exploitable —
    // the surface is browser-only and the store is keyed by opaque id — but the
    // composer now hydrates from the GET on mount, so a wrong id must fail
    // loudly rather than return a confident answer about nothing.
    const knownSession = (id: string, reply: FastifyReply): boolean => {
      if (deps.sessionManager.get(id)) return true;
      reply.code(404).send({ error: "Session not found" });
      return false;
    };

    // Read a session's egress view (override + per-session hosts + resolution).
    app.get<{ Params: { id: string } }>(
      "/api/egress/session/:id",
      async (request, reply) => {
        if (!knownSession(request.params.id, reply)) return;
        return sessionSettings(store, request.params.id, enforcement, liveContained(request.params.id));
      },
    );

    // Set/clear a session's containment override (null = inherit global).
    //
    // docs/279 req 8 — this change was entirely silent: it persisted the override
    // and the only trace was the radio button's own position. Network access is
    // a trust boundary like any capability grant, so an actual change now leaves
    // the same persisted transcript card a sandbox capability edit does.
    app.put<{ Params: { id: string }; Body: { override?: boolean | null } }>(
      "/api/egress/session/:id",
      async (request, reply) => {
        const sessionId = request.params.id;
        if (!knownSession(sessionId, reply)) return;
        // docs/285 — an `override` that is not exactly one of the three values
        // used to be IGNORED: the route fell through, changed nothing, and
        // returned 200 with the unchanged view. A client writing `"open"` or
        // `undefined` got a success it could not distinguish from a real write,
        // which is the worst possible answer for a control whose Send barrier is
        // released by that very response.
        const override = request.body?.override;
        if (override !== true && override !== false && override !== null) {
          reply.code(400).send({ error: "override must be true, false, or null" });
          return;
        }
        const rebuild = await serializeNetworkModeWrite(sessionId, async () => {
          const previous = store.getSessionOverride(sessionId);
          store.setSessionOverride(sessionId, override);

          // docs/285 req 3 — a session that has NOT run a turn yet gets its
          // container rebuilt right here, and this route does not answer until it
          // has been. That is the whole mechanism: containment is plumbed at
          // container creation and a running container cannot be re-plumbed, so
          // the pick has to reach a *new* container before the first turn goes
          // out.
          //
          // Doing it at the write rather than at the first Send is what keeps the
          // feature small. The container is created immediately after the value it
          // reads was written, by the only writer there is, so there is no window
          // for the two to disagree and nothing to freeze. The composer's existing
          // save barrier keeps Send unavailable for the duration, which is the
          // "wait for the container" state — the same one `/new` already shows
          // before its session is claimed.
          //
          // A GRADUATED session is deliberately untouched: restarting a container
          // out from under a session the user is working in is not a settings
          // change, it is Rescue. Those keep the "applies on next container start"
          // pending state they have always had.
          const stillWarm = deps.sessionManager.get(sessionId)?.warm === true;
          if (stillWarm && deps.reconcileSessionEgress) {
            // Deliberately NOT gated on `previous !== override`. The rebuild is
            // already a no-op when the container matches, so the gate saves
            // nothing — and it blocks the one case that needs it most: re-picking
            // a mode after a rebuild FAILED would return 200 with the container
            // still on the old topology, so the control could never self-heal.
            const outcome = await deps.reconcileSessionEgress(sessionId);
            if (outcome.action === "aborted") {
              // Roll the write back. Leaving it persisted is what turned a
              // refusal into a silent mismatch: the client re-reads after a
              // failed write, would have read back the value it just asked for,
              // and released Send — over a container still running the mode the
              // user was trying to replace.
              store.setSessionOverride(sessionId, previous);
              return { previous, stillWarm, aborted: outcome };
            }
          }
          return { previous, stillWarm, aborted: null };
        });
        if (rebuild.aborted) {
          reply.code(503).send({
            error: rebuild.aborted.message,
            offerRescue: rebuild.aborted.offerRescue,
          });
          return;
        }
        const { previous, stillWarm } = rebuild;
        // docs/285 — a card is written for a CHANGE. A session that has not
        // graduated has no prior state for one to describe: "changed network
        // containment" above the first message would report an edit to a session
        // the user experiences as still being created. The creation-time choice
        // is therefore silent, and every later change still carries the docs/279
        // audit card.
        if (previous !== override && !stillWarm) {
          // The card's `pendingRestart` is the SAME value this route is about
            // to report to the dialog, read after the write. It used to be
            // hardcoded `true` on the reasoning that egress topology is always a
            // creation-time choice — but "the topology is fixed at creation" is
            // not "this change alters it": with no running container, or with
            // one already started in the resolved containment (global Contained,
            // Inherit → Contained), nothing is pending. The dialog would have
            // shown no pending row while the transcript card beside it said
            // "applies on next container start". (Review finding.)
          emitSessionSettingsChangeCard(
            { runnerRegistry: deps.runnerRegistry, chatHistoryManager: deps.chatHistoryManager },
            sessionId,
            "network-mode",
            [{
              label: "Network containment",
              from: egressModeLabel(previous),
              to: egressModeLabel(override),
            }],
            sessionSettings(store, sessionId, enforcement, liveContained(sessionId)).pendingRestart,
          );
        }
        // docs/285 — a transient, session-scoped invalidation so the OTHER
        // surfaces showing this value refresh: the composer control and the
        // Session settings dialog can be open at once, in this tab or another.
        //
        // It exists because neither existing signal can serve. The persisted
        // `session_settings_change_card` is suppressed for the creation-time
        // choice above, so another tab would receive nothing at all; and the
        // global `egress_settings` event is not broadcast by this route, nor
        // should it be — this changes one session, not the instance.
        //
        // Transient by design: this carries INVALIDATION, while the persisted
        // card carries AUDIT. Two signals, two jobs.
        deps.sseBroadcast("session_egress_changed", { sessionId });
        return sessionSettings(store, sessionId, enforcement, liveContained(sessionId));
      },
    );
  }

  app.get<{ Querystring: { host?: string; session?: string } }>(
    "/api/egress/decision",
    { config: { containerAccessible: true } },
    async (request, reply: FastifyReply) => {
      const host = typeof request.query.host === "string" ? request.query.host.trim() : "";
      const sessionId = typeof request.query.session === "string" ? request.query.session.trim() : "";
      if (!host || !sessionId) {
        reply.code(400).send({ error: "host and session are required" });
        return { allow: false };
      }

      // The verdict is read EXHAUSTIVELY, and that is the point rather than a
      // formality (review finding): a partial reading left the sealed session
      // below sealed for an unknown host and open for a lifeline one, which is
      // two predicates again. `allowed` is the session's own configured reach —
      // the live answer for a host the proxy's creation-time snapshot lacks;
      // `grantable` continues to the decision flow below; either `blocked-*` is
      // refused outright.
      //
      // planning#380 — a session no user grant can widen is answered here and
      // goes no further, and the SAME predicate the Plugins card reads decides
      // that (planning#383). docs/211's Network-off sandbox is the case that
      // exists today: its `network` capability "only ever tightens", its reach
      // is the lifeline, and `sandboxLifelineEgressConfig` ignores the allowlist
      // store outright. A `blocked-by-deployment` verdict cannot arrive here in
      // practice — with Tier B off there is no Tier C proxy to ask — and is
      // refused by the same rule rather than by an exception to it.
      //
      // This was a hole, not merely an optimistic answer, because Tier A's ipset
      // floor is session-INDEPENDENT: `EGRESS_TIER_A_RESOLVE_HOSTS` plus the
      // GitHub CIDRs are admitted in every session, sandbox included. A workload
      // that pins a co-tenant IP from that floor (`curl --resolve`, /etc/hosts)
      // skips the resolver entirely and arrives here with the excluded host's
      // SNI — and `allow` splices it. That is the CDN co-tenancy case Tier C
      // exists to refuse.
      //
      // No card either, and that is the same rule rather than an omission: the
      // card's whole content is a grant offer, a durable add is inert in this
      // session (#2284's grant report already says so), and an allow-once would
      // widen a session the user sealed. docs/211 places the "allow this host?"
      // card under Network ON for exactly this reason. The user is not left
      // guessing in practice — Tier B refuses the name on every ordinary attempt,
      // so this path is only reached by deliberate IP-pinning.
      const reach = reachFor(sessionId, host);
      if (reach !== "grantable") return { allow: reach === "allowed" };

      if (isEgressHostAllowed(sessionId, host)) {
        return { allow: true };
      }

      // Not allowed → deny-fast. Surface a card (once) if the session is active.
      const runner = deps.runnerRegistry.get(sessionId);
      if (runner && shouldCardEgressHost(sessionId, host)) {
        const cardId = egressCardId(sessionId, host);
        const createdAt = new Date().toISOString();
        const persisted: PersistedEgressPrompt = { cardId, host: normalizeHost(host), phase: "pending", createdAt };
        emitChatCard(
          runner,
          { type: "egress_prompt_card", sessionId, cardId, host: normalizeHost(host), createdAt },
          { role: "assistant", text: "", egressPrompt: persisted },
          { chatHistoryManager: deps.chatHistoryManager, sessionId },
        );
      }
      return { allow: false };
    },
  );
}
