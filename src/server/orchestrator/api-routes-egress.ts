/**
 * Egress decision API route (docs/172 Gap 1, SHI-90 — Tier C allow-once).
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
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { emitChatCard } from "./chat-card-persistence.js";
import { isEgressHostAllowed, shouldCardEgressHost } from "./egress-policy.js";
import { normalizeHost, buildEffectiveAllowlist, isBuiltinDefault } from "./egress-allowlist.js";
import { EGRESS_GLOBAL_SCOPE } from "./egress-allowlist-store.js";
import type { EgressAllowlistStore } from "./egress-allowlist-store.js";
import type { CredentialStore } from "./credential-store.js";
import type { EgressSettings, EgressSessionSettings, EgressAllowlistView } from "../shared/types.js";
import type { PersistedEgressPrompt } from "./chat-history.js";

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
  // distinguish containment policy from enforcement (docs/172, SHI-90).
  const enforcementActive = deps.egressEnforcementActive ?? false;

  // The containment a session's LIVE container was actually started with — the
  // source of truth for "pending · restart to apply" (docs/172). `null` when no
  // running container exists (nothing plumbed to diff against, nothing to
  // restart). Reads the in-memory container record (the egress sidecars are a
  // creation-time topology choice recorded there), never the agent's netns, so
  // this stays on the browser-only surface (SHI-129).
  const liveContained = (sessionId: string): boolean | null => {
    const sc = deps.containerManager?.get(sessionId);
    if (sc?.status !== "running") return null;
    return sc.egressContainedAtStart ?? null;
  };

  // ---- Browser-only egress settings (docs/172, SHI-90) ------------------
  // NO `containerAccessible` flag: SHI-129's default-deny keeps the contained
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
    app.post<{ Body: { host?: string; scope?: string } }>(
      "/api/egress/hosts",
      async (request, reply) => {
        const host = typeof request.body?.host === "string" ? request.body.host.trim() : "";
        const scope = typeof request.body?.scope === "string" && request.body.scope ? request.body.scope : EGRESS_GLOBAL_SCOPE;
        if (!host) {
          reply.code(400);
          return { error: "host is required" };
        }
        // Re-adding a removed built-in default just un-suppresses it (it's a
        // default, not a user entry). Otherwise it's a user-added host.
        if (scope === EGRESS_GLOBAL_SCOPE && isBuiltinDefault(host)) {
          store.unsuppressDefault(host);
        } else {
          store.addHost(scope, host);
        }
        deps.sseBroadcast("egress_settings", globalSettings(store, enforcementActive));
        // A per-session add can take effect immediately on a running session.
        if (scope !== EGRESS_GLOBAL_SCOPE) {
          void deps.containerManager?.reloadEgress(scope).catch(() => {});
          return sessionSettings(store, scope, enforcementActive, liveContained(scope));
        }
        return globalSettings(store, enforcementActive);
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
    app.put<{ Params: { id: string }; Body: { override?: boolean | null } }>(
      "/api/egress/session/:id",
      async (request) => {
        const override = request.body?.override;
        if (override === true || override === false || override === null) {
          store.setSessionOverride(request.params.id, override);
        }
        return sessionSettings(store, request.params.id, enforcementActive, liveContained(request.params.id));
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
