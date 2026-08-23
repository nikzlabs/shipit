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

/** Snapshot the global egress settings (toggle + user allowlist + enforcement). */
function globalSettings(store: EgressAllowlistStore, enforcementActive: boolean): EgressSettings {
  return {
    globalEnabled: store.getGlobalEnabled(),
    globalHosts: store.listHosts(EGRESS_GLOBAL_SCOPE),
    enforcementActive,
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
  enforcementActive: boolean,
  startedContained: boolean | null,
): EgressSessionSettings {
  const effectiveContained = store.resolveContained(sessionId);
  return {
    sessionId,
    override: store.getSessionOverride(sessionId),
    hosts: store.listHosts(sessionId),
    effectiveContained,
    globalEnabled: store.getGlobalEnabled(),
    enforcementActive,
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
  enforcementActive: boolean,
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
    enforcementActive,
    session: sessionId ? sessionSettings(store, sessionId, enforcementActive, startedContained) : null,
    defaultsCustomized: store.hasSuppressedDefaults(),
  };
}

export async function registerEgressRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const store = deps.egressAllowlistStore;
  // Whether this deployment can actually ENFORCE containment (enforcement on +
  // sidecar image configured). Resolved once at registration — it's a fixed
  // function of the process env. The honest signal the browser uses to
  // distinguish containment policy from enforcement (docs/172, planning#92).
  const enforcementActive = deps.egressEnforcementActive ?? false;
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
    app.get("/api/egress/settings", async () => globalSettings(store, enforcementActive));

    // The effective allowlist with provenance (built-in / operator / MCP /
    // user-added) for the Settings editor. `?session=<id>` folds in that
    // session's per-session extras + override/resolution.
    app.get<{ Querystring: { session?: string } }>(
      "/api/egress/allowlist",
      async (request) => {
        const sessionId =
          typeof request.query.session === "string" && request.query.session ? request.query.session : undefined;
        return allowlistView(store, deps.credentialStore, sessionId, enforcementActive, sessionId ? liveContained(sessionId) : null);
      },
    );

    // Flip the global toggle (Contained ↔ Open). Applies at the next container
    // start — egress is a creation-time choice; the client states that.
    app.put<{ Body: { globalEnabled?: boolean } }>(
      "/api/egress/settings",
      async (request) => {
        if (typeof request.body?.globalEnabled === "boolean") {
          store.setGlobalEnabled(request.body.globalEnabled);
          deps.sseBroadcast("egress_settings", globalSettings(store, enforcementActive));
        }
        return globalSettings(store, enforcementActive);
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
        deps.sseBroadcast("egress_settings", globalSettings(store, enforcementActive));
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
              settings: sessionSettings(store, scope, enforcementActive, liveContained(scope)),
            };
          }
          return { ...sessionSettings(store, scope, enforcementActive, liveContained(scope)), grant: grant(reloaded) };
        }
        // A global add reloads nothing at all, by design (`plugin-egress.ts`).
        return { ...globalSettings(store, enforcementActive), grant: grant(false) };
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
        deps.sseBroadcast("egress_settings", globalSettings(store, enforcementActive));
        return scope === EGRESS_GLOBAL_SCOPE
          ? globalSettings(store, enforcementActive)
          : sessionSettings(store, scope, enforcementActive, liveContained(scope));
      },
    );

    // Restore all built-in defaults (clear every user suppression).
    app.post("/api/egress/defaults/restore", async () => {
      store.restoreDefaults();
      deps.sseBroadcast("egress_settings", globalSettings(store, enforcementActive));
      return allowlistView(store, deps.credentialStore, undefined, enforcementActive, null);
    });

    // Read a session's egress view (override + per-session hosts + resolution).
    app.get<{ Params: { id: string } }>(
      "/api/egress/session/:id",
      async (request) => sessionSettings(store, request.params.id, enforcementActive, liveContained(request.params.id)),
    );

    // Set/clear a session's containment override (null = inherit global).
    //
    // docs/279 req 8 — this change was entirely silent: it persisted the override
    // and the only trace was the radio button's own position. Network access is
    // a trust boundary like any capability grant, so an actual change now leaves
    // the same persisted transcript card a sandbox capability edit does.
    app.put<{ Params: { id: string }; Body: { override?: boolean | null } }>(
      "/api/egress/session/:id",
      async (request) => {
        const sessionId = request.params.id;
        const override = request.body?.override;
        if (override === true || override === false || override === null) {
          const previous = store.getSessionOverride(sessionId);
          store.setSessionOverride(sessionId, override);
          if (previous !== override) {
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
              sessionSettings(store, sessionId, enforcementActive, liveContained(sessionId)).pendingRestart,
            );
          }
        }
        return sessionSettings(store, sessionId, enforcementActive, liveContained(sessionId));
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
